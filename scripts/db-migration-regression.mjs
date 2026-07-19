/**
 * @fileoverview 数据库升级回归测试：重建 accounts 时必须保留外键子表数据。
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import Database from 'better-sqlite3';

test('重建 accounts CHECK 约束时保留外键子表数据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-db-migration-'));
  const dbPath = join(dir, 'legacy.db');
  process.env.XHS_MCP_DATA_DIR = dir;

  try {
    const legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        proxy TEXT,
        state JSON,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','banned')),
        last_login_at DATETIME,
        last_active_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE account_profiles (
        account_id TEXT PRIMARY KEY,
        user_id TEXT,
        red_id TEXT,
        nickname TEXT,
        avatar TEXT,
        description TEXT,
        gender INTEGER,
        followers INTEGER,
        following INTEGER,
        notes_count INTEGER,
        updated_at DATETIME,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      INSERT INTO accounts(id, name, status) VALUES ('a1', 'legacy', 'active');
      INSERT INTO account_profiles(account_id, user_id, nickname) VALUES ('a1', 'u1', 'keep-me');
    `);
    legacy.close();

    const [{ XhsDatabase }, { adoptSingleLegacyProfile, generateProfileId }] = await Promise.all([
      import('../dist/db/index.js'),
      import('../dist/core/profile.js'),
    ]);
    const db = new XhsDatabase(dbPath);
    await db.init();

    assert.equal(db.get('SELECT COUNT(*) AS count FROM accounts').count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM account_profiles').count, 1);
    assert.equal(db.get('SELECT nickname FROM account_profiles WHERE account_id = ?', ['a1']).nickname, 'keep-me');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);

    const legacyProfile = join(dir, 'browser-profile');
    mkdirSync(legacyProfile, { recursive: true, mode: 0o700 });
    chmodSync(legacyProfile, 0o700);
    writeFileSync(join(legacyProfile, 'cookie-marker'), 'preserved');
    const profileId = generateProfileId();
    const profileRoot = join(dir, 'browser-profiles');
    const isolatedProfile = join(profileRoot, profileId);
    mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    chmodSync(profileRoot, 0o700);
    writeFileSync(
      join(dir, 'browser-profile.adoption.json'),
      `${JSON.stringify({ version: 1, accountId: 'a1', profileId })}\n`,
      { mode: 0o600 },
    );
    renameSync(legacyProfile, isolatedProfile);
    // 模拟 rename 后、symlink 前退出；下一次 db.init/ensureDirectories 已补出空旧目录。
    mkdirSync(legacyProfile, { mode: 0o700 });
    const adoption = adoptSingleLegacyProfile(db.accounts);
    const migratedAccount = db.accounts.findById('a1');

    assert.equal(adoption.adopted, true);
    assert.equal(migratedAccount?.status, 'active');
    assert.equal(migratedAccount?.profileId, adoption.profileId);
    assert.equal(lstatSync(legacyProfile).isSymbolicLink(), true);
    assert.equal(existsSync(join(legacyProfile, 'cookie-marker')), true);
    assert.equal(existsSync(join(isolatedProfile, 'cookie-marker')), true);

    const removed = db.accounts.deleteWithProfileId('a1');
    assert.deepEqual(removed, { deleted: true, profileId });
    assert.equal(db.accounts.findById('a1'), null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
