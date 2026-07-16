/**
 * @fileoverview 蓝军 #1 回归测试：executeWithAccount 对非 active 账号（migration_required 等）拒绝平台操作。
 * 用 mock 的 pool/db 隔离，避免依赖 better-sqlite3（bun 不支持）。
 * @module core/multi-account.test
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { executeWithAccount } from './multi-account.js';
import { config } from './config.js';
import type { AccountPool } from './account-pool.js';
import type { XhsDatabase } from '../db/index.js';

function makeMocks(account: any) {
  const pool: any = {
    getAccount: () => account,
    acquireLock: async () => () => {},
    getClient: async () => ({ fake: true }),
    touchAccount: () => {},
  };
  const db: any = { operations: { log: () => {} } };
  return { pool: pool as unknown as AccountPool, db: db as unknown as XhsDatabase };
}

describe('蓝军 #1 非 active 账号拒绝平台操作', () => {
  beforeAll(() => {
    // 关闭无关门禁，聚焦验证 status 检查本身
    config.antiDetect.liveness.enabled = false;
    config.antiDetect.headlessWriteGate.enabled = false;
    config.antiDetect.quota.enabled = false;
    config.antiDetect.cooccurrence.enabled = false;
    config.browser.headless = false;
  });

  it('migration_required 账号被拒绝（skipped，不执行操作）', async () => {
    const account = { id: 'a1', name: 'acc', status: 'migration_required' };
    const { pool, db } = makeMocks(account);
    let called = false;
    const res = await executeWithAccount(pool, db, 'a1', 'search', async () => {
      called = true;
      return 'ok';
    });
    expect(res.success).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.error).toContain('account_inactive');
    expect(called).toBe(false);
  });

  it('active 账号正常执行操作', async () => {
    const account = { id: 'a2', name: 'acc2', status: 'active' };
    const { pool, db } = makeMocks(account);
    let called = false;
    const res = await executeWithAccount(pool, db, 'a2', 'search', async () => {
      called = true;
      return 'ok';
    });
    expect(called).toBe(true);
    expect(res.success).toBe(true);
    expect(res.result).toBe('ok');
  });

  it('suspended 账号同样被拒绝', async () => {
    const account = { id: 'a3', name: 'acc3', status: 'suspended' };
    const { pool, db } = makeMocks(account);
    let called = false;
    const res = await executeWithAccount(pool, db, 'a3', 'search', async () => {
      called = true;
      return 'ok';
    });
    expect(res.success).toBe(false);
    expect(res.skipped).toBe(true);
    expect(called).toBe(false);
  });
});
