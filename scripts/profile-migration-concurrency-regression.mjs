/**
 * @fileoverview 旧 profile 迁移的真实双进程竞态回归测试。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'xhs-profile-race-'));
process.env.XHS_MCP_DATA_DIR = root;

const dbModule = pathToFileURL(resolve('dist/db/index.js')).href;
const profileModule = pathToFileURL(resolve('dist/core/profile.js')).href;
const poolModule = pathToFileURL(resolve('dist/core/account-pool.js')).href;
const { XhsDatabase } = await import(dbModule);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const adopterSource = `
  import { existsSync, writeFileSync } from 'node:fs';
  const [{ XhsDatabase }, { adoptSingleLegacyProfile }] = await Promise.all([
    import(process.env.XHS_TEST_DB_MODULE),
    import(process.env.XHS_TEST_PROFILE_MODULE),
  ]);
  const db = new XhsDatabase();
  writeFileSync(process.env.XHS_TEST_READY, 'ready');
  while (!existsSync(process.env.XHS_TEST_START)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  try {
    const result = adoptSingleLegacyProfile(db.accounts, {
      expectedAccountId: process.env.XHS_MCP_LEGACY_PROFILE_ACCOUNT_ID,
    });
    process.stdout.write(JSON.stringify(result));
  } finally {
    db.close();
  }
`;

const deleterSource = `
  import { existsSync, writeFileSync } from 'node:fs';
  const [{ XhsDatabase }, { AccountPool }] = await Promise.all([
    import(process.env.XHS_TEST_DB_MODULE),
    import(process.env.XHS_TEST_POOL_MODULE),
  ]);
  const db = new XhsDatabase();
  const pool = new AccountPool(db);
  writeFileSync(process.env.XHS_TEST_READY, 'ready');
  while (!existsSync(process.env.XHS_TEST_START)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  try {
    const removed = await pool.removeAccount(process.env.XHS_TEST_ACCOUNT_ID);
    process.stdout.write(JSON.stringify({ removed }));
  } finally {
    db.close();
  }
`;

after(() => rmSync(root, { recursive: true, force: true }));

async function createFixture(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dbPath = join(dir, 'data.db');
  const db = new XhsDatabase(dbPath);
  await db.init();
  const account = db.accounts.create('legacy-account');
  db.close();

  const legacyProfile = join(dir, 'browser-profile');
  mkdirSync(legacyProfile, { mode: 0o700 });
  chmodSync(legacyProfile, 0o700);
  writeFileSync(join(legacyProfile, 'cookie-marker'), 'preserved');
  return { dir, dbPath, account, legacyProfile };
}

function spawnContender(source, fixture, ready, start) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XHS_MCP_DATA_DIR: fixture.dir,
      XHS_MCP_LEGACY_PROFILE_ACCOUNT_ID: fixture.account.id,
      XHS_TEST_ACCOUNT_ID: fixture.account.id,
      XHS_TEST_DB_MODULE: dbModule,
      XHS_TEST_PROFILE_MODULE: profileModule,
      XHS_TEST_POOL_MODULE: poolModule,
      XHS_TEST_READY: ready,
      XHS_TEST_START: start,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const completed = new Promise((resolveCompleted) => {
    child.on('close', (code, signal) => resolveCompleted({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function waitUntilReady(paths, contenders) {
  const deadline = Date.now() + 10_000;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) {
      for (const contender of contenders) contender.child.kill();
      const results = await Promise.all(contenders.map((contender) => contender.completed));
      throw new Error(`contenders did not become ready: ${JSON.stringify(results)}`);
    }
    await delay(10);
  }
}

async function race(fixture, sources) {
  const start = join(fixture.dir, 'start');
  const readyPaths = sources.map((_, index) => join(fixture.dir, `ready-${index}`));
  const contenders = sources.map((source, index) => spawnContender(source, fixture, readyPaths[index], start));
  await waitUntilReady(readyPaths, contenders);
  writeFileSync(start, 'go');
  const results = await Promise.all(contenders.map((contender) => contender.completed));
  for (const result of results) {
    assert.equal(result.code, 0, `child failed: ${result.stderr}`);
    assert.equal(result.signal, null);
  }
  return results;
}

function liveProfiles(dir) {
  const profileRoot = join(dir, 'browser-profiles');
  if (!existsSync(profileRoot)) return [];
  return readdirSync(profileRoot).filter((name) => {
    if (!UUID_PATTERN.test(name)) return false;
    return lstatSync(join(profileRoot, name)).isDirectory();
  });
}

test('两个进程同时接管时只生成并绑定一个 profile', async () => {
  const fixture = await createFixture('two-adopters');
  const results = await race(fixture, [adopterSource, adopterSource]);
  const verifier = new XhsDatabase(fixture.dbPath);
  try {
    const account = verifier.accounts.findById(fixture.account.id);
    assert.equal(account?.status, 'active');
    assert.match(account?.profileId ?? '', UUID_PATTERN);
    assert.deepEqual(liveProfiles(fixture.dir), [account.profileId]);
    assert.equal(lstatSync(fixture.legacyProfile).isSymbolicLink(), true);
    assert.equal(
      resolve(dirname(fixture.legacyProfile), readlinkSync(fixture.legacyProfile)),
      resolve(join(fixture.dir, 'browser-profiles', account.profileId)),
    );
    assert.equal(existsSync(join(fixture.dir, 'browser-profile.adoption.json')), false);
    assert.equal(existsSync(join(fixture.dir, 'browser-profile.migration.lock')), false);
    const outcomes = results.map((result) => JSON.parse(result.stdout).adopted).sort();
    assert.deepEqual(outcomes, [false, true]);
  } finally {
    verifier.close();
  }
});

test('接管与删除并发时最终不遗留账号、marker、兼容链接或活动 profile', async () => {
  const fixture = await createFixture('adopt-delete');
  const results = await race(fixture, [adopterSource, deleterSource]);
  const verifier = new XhsDatabase(fixture.dbPath);
  try {
    assert.equal(verifier.accounts.findById(fixture.account.id), null);
    assert.deepEqual(liveProfiles(fixture.dir), []);
    assert.equal(existsSync(fixture.legacyProfile), false);
    assert.equal(existsSync(join(fixture.dir, 'browser-profile.adoption.json')), false);
    assert.equal(existsSync(join(fixture.dir, 'browser-profile.migration.lock')), false);
    assert.equal(JSON.parse(results[1].stdout).removed, true);
  } finally {
    verifier.close();
  }
});
