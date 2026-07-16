/**
 * @fileoverview 蓝军 #1 回归测试：executeWithAccount 对非 active 账号（migration_required 等）拒绝平台操作。
 * 用 mock 的 pool/db 隔离，避免依赖 better-sqlite3（bun 不支持）。
 * @module core/multi-account.test
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { executeWithAccount, executeWithMultipleAccounts } from './multi-account.js';
import { config } from './config.js';
// 测试中需要调整全局开关；用局部可变别名绕过 config 的只读声明（仅测试副作用）
const cfg = config as any;
import { getCooccurrenceGuard } from './antidetect.js';
import { sleep } from '../xhs/utils/index.js';
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
    cfg.antiDetect.liveness.enabled = false;
    cfg.antiDetect.headlessWriteGate.enabled = false;
    cfg.antiDetect.quota.enabled = false;
    cfg.antiDetect.cooccurrence.enabled = false;
    cfg.browser.headless = false;
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

describe('蓝军 #3 能力分级门禁', () => {
  beforeAll(() => {
    cfg.antiDetect.liveness.enabled = false;
    cfg.antiDetect.headlessWriteGate.enabled = true;
    cfg.antiDetect.quota.enabled = true;
    cfg.antiDetect.cooccurrence.enabled = false;
    cfg.browser.headless = true;
  });
  beforeEach(() => getCooccurrenceGuard().reset());

  it('只读能力绕过账号状态门禁（migration_required 仍可读取）', async () => {
    const account = { id: 'rd', name: 'rd', status: 'migration_required' };
    const { pool, db } = makeMocks(account);
    let called = false;
    const res = await executeWithAccount(pool, db, 'rd', 'search', async () => {
      called = true;
      return 'ok';
    }, { capability: 'read' });
    expect(called).toBe(true);
    expect(res.success).toBe(true);
  });

  it('控制能力（停止）即便 headless 也无条件放行，而写操作被 headless 门禁拦截', async () => {
    const account = { id: 'ctl', name: 'ctl', status: 'active' };
    const { pool, db } = makeMocks(account);
    const stop = await executeWithAccount(pool, db, 'ctl', 'stop_explore', async () => 'stopped', {
      capability: 'control',
    });
    expect(stop.success).toBe(true);

    const write = await executeWithAccount(pool, db, 'ctl', 'like', async () => 'ok', {
      capability: 'write',
    });
    expect(write.skipped).toBe(true);
    expect(write.error).toBe('headless_write_blocked');
  });

  it('默认（write）仍受账号状态门禁约束', async () => {
    const account = { id: 'rd2', name: 'rd2', status: 'migration_required' };
    const { pool, db } = makeMocks(account);
    const res = await executeWithAccount(pool, db, 'rd2', 'like', async () => 'ok', {
      capability: 'write',
    });
    expect(res.skipped).toBe(true);
    expect(res.error).toContain('account_inactive');
  });
});

describe('蓝军 #4/#5 并发原子预占与业务失败熔断', () => {
  beforeAll(() => {
    cfg.antiDetect.liveness.enabled = false;
    cfg.antiDetect.headlessWriteGate.enabled = false;
    cfg.antiDetect.cooccurrence.enabled = false;
    cfg.antiDetect.quota.enabled = true;
    cfg.antiDetect.quota.perAccountDaily = 100;
    cfg.browser.headless = false;
  });
  beforeEach(() => {
    cfg.antiDetect.quota.perAccountHourly = 2;
    cfg.antiDetect.quota.cooldownMsAfterAction = 0;
    cfg.antiDetect.quota.consecutiveFailuresToTrip = 2;
    getCooccurrenceGuard().reset();
  });

  it('蓝军 #4 并发写操作不越过预算（原子预占，无 TOCTOU 双计）', async () => {
    cfg.antiDetect.quota.perAccountHourly = 1;
    const account = { id: 'c1', name: 'conc', status: 'active' };
    const { pool, db } = makeMocks(account);
    let ran = 0;
    const op = async () => {
      ran += 1;
      await sleep(20);
      return 'ok';
    };
    const [r1, r2] = await Promise.all([
      executeWithAccount(pool, db, 'c1', 'like', op, { capability: 'write' }),
      executeWithAccount(pool, db, 'c1', 'like', op, { capability: 'write' }),
    ]);
    // 仅一次实际操作被执行（第二次在原子检查处被预算拦截）
    expect(ran).toBe(1);
    expect([r1, r2].filter((r) => r.success).length).toBe(1);
    expect([r1, r2].some((r) => r.skipped && r.error === 'quota_exceeded')).toBe(true);
  });

  it('蓝军 #5 业务失败（验证码，即便 HTTP 成功）触发熔断并取消剩余队列', async () => {
    const account = { id: 'b1', name: 'biz', status: 'active' };
    const { pool, db } = makeMocks(account);
    const res = await executeWithAccount(
      pool,
      db,
      'b1',
      'like',
      async () => ({ needVerify: true, success: true }),
      { capability: 'write' },
    );
    expect(res.success).toBe(true); // 操作本身返回成功
    expect(res.trippedNow).toBe(true); // 但业务失败触发熔断
    expect(getCooccurrenceGuard().isTripped('b1')).toBe(true);

    // 后续写被熔断拦截
    const res2 = await executeWithAccount(pool, db, 'b1', 'like', async () => 'ok', {
      capability: 'write',
    });
    expect(res2.skipped).toBe(true);
    expect(res2.error).toBe('circuit_breaker_tripped');
  });

  it('蓝军 #5 多账号串行队列在熔断后立即取消剩余账号', async () => {
    cfg.antiDetect.quota.consecutiveFailuresToTrip = 1;
    const accts = [
      { id: 'q1', name: 'q1', status: 'active' },
      { id: 'q2', name: 'q2', status: 'active' },
    ];
    const pool: any = {
      getAccount: (name: string) => accts.find((a) => a.name === name) ?? accts[0],
      acquireLock: async () => () => {},
      getClient: async () => ({ fake: true }),
      touchAccount: () => {},
      listAccounts: () => accts,
    };
    const db: any = { operations: { log: () => {} } };
    // q1 业务失败触发熔断；串行执行下 q2 应被取消而非执行
    const results = await executeWithMultipleAccounts(
      pool as unknown as AccountPool,
      db as unknown as XhsDatabase,
      { accounts: ['q1', 'q2'] },
      'like',
      async (ctx) =>
        ctx.accountId === 'q1' ? ({ needVerify: true } as any) : 'ok',
      { capability: 'write', sequential: true },
    );
    expect(results).toHaveLength(2);
    const q1 = results.find((r) => r.account === 'q1')!;
    const q2 = results.find((r) => r.account === 'q2')!;
    expect(q1.trippedNow).toBe(true);
    expect(q2.skipped).toBe(true);
    expect(q2.error).toBe('queue_cancelled_circuit_breaker');
  });

  it('蓝军 #5 执行失败回滚预算（不浪费配额，允许后续重试）', async () => {
    cfg.antiDetect.quota.perAccountHourly = 1;
    cfg.antiDetect.quota.consecutiveFailuresToTrip = 5;
    const account = { id: 'r1', name: 'rb', status: 'active' };
    const { pool, db } = makeMocks(account);
    const r1 = await executeWithAccount(pool, db, 'r1', 'like', async () => {
      throw new Error('boom');
    }, { capability: 'write' });
    expect(r1.success).toBe(false);
    // 预算已回滚，第二次写入仍被允许
    const r2 = await executeWithAccount(pool, db, 'r1', 'like', async () => 'ok', {
      capability: 'write',
    });
    expect(r2.success).toBe(true);
  });
});
