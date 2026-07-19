/**
 * @fileoverview 数据库升级回归测试：重建 accounts 时必须保留外键子表数据。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

    const { XhsDatabase } = await import('../dist/db/index.js');
    const db = new XhsDatabase(dbPath);
    await db.init();

    assert.equal(db.get('SELECT COUNT(*) AS count FROM accounts').count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM account_profiles').count, 1);
    assert.equal(db.get('SELECT nickname FROM account_profiles WHERE account_id = ?', ['a1']).nickname, 'keep-me');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
