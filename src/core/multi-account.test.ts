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

  it('只读能力绕过账号状态门禁（suspended 仍可读取）', async () => {
    const account = { id: 'rd', name: 'rd', status: 'suspended' };
    const { pool, db } = makeMocks(account);
    let called = false;
    const res = await executeWithAccount(pool, db, 'rd', 'search', async () => {
      called = true;
      return 'ok';
    }, { capability: 'read' });
    expect(called).toBe(true);
    expect(res.success).toBe(true);
  });

  it('R2-6 migration_required 账号对所有能力拒绝触网（避免回退共享 profile）', async () => {
    const account = { id: 'mig', name: 'mig', status: 'migration_required' };
    const { pool, db } = makeMocks(account);
    let called = false;
    const res = await executeWithAccount(pool, db, 'mig', 'search', async () => {
      called = true;
      return 'ok';
    }, { capability: 'read' });
    expect(called).toBe(false);
    expect(res.success).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.error).toContain('migration_required');
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
    cfg.antiDetect.proxyRequired.mode = 'off'; // 本套聚焦配额/熔断，关闭 A1 门禁
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

describe('A1 多账号写代理门禁', () => {
  beforeAll(() => {
    cfg.antiDetect.liveness.enabled = false;
    cfg.antiDetect.headlessWriteGate.enabled = false;
    cfg.antiDetect.quota.enabled = false;
    cfg.antiDetect.cooccurrence.enabled = false;
    cfg.browser.headless = false;
  });
  beforeEach(() => {
    cfg.antiDetect.proxyRequired.mode = 'block';
    getCooccurrenceGuard().reset();
  });

  function poolWith(accts: Array<{ id: string; name: string; status: string; proxy?: string | null }>) {
    const pool: any = {
      getAccount: (key: string) =>
        accts.find((a) => a.name === key || a.id === key) ?? null,
      acquireLock: async () => () => {},
      getClient: async () => ({ fake: true }),
      touchAccount: () => {},
      listAccounts: () => accts,
    };
    const db: any = { operations: { log: () => {} } };
    return { pool: pool as unknown as AccountPool, db: db as unknown as XhsDatabase };
  }

  it('双账号无 proxy → proxy_required skip', async () => {
    const accts = [
      { id: '1', name: 'a', status: 'active', proxy: null },
      { id: '2', name: 'b', status: 'active', proxy: null },
    ];
    const { pool, db } = poolWith(accts);
    let ran = 0;
    const results = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: ['a', 'b'] },
      'like',
      async () => {
        ran += 1;
        return 'ok';
      },
      { capability: 'write', sequential: true },
    );
    expect(ran).toBe(0);
    expect(results.every((r) => r.skipped && r.error === 'proxy_required')).toBe(true);
  });

  it('同 server → 后者 proxy_shared', async () => {
    const accts = [
      { id: '1', name: 'a', status: 'active', proxy: 'http://p:8080' },
      { id: '2', name: 'b', status: 'active', proxy: 'http://user:pass@p:8080' },
    ];
    const { pool, db } = poolWith(accts);
    const results = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: ['a', 'b'] },
      'like',
      async () => 'ok',
      { capability: 'write', sequential: true },
    );
    expect(results.find((r) => r.account === 'a')!.success).toBe(true);
    expect(results.find((r) => r.account === 'b')!.error).toBe('proxy_shared');
  });

  it('互异 proxy 放行；单账号无 proxy 放行', async () => {
    const duo = [
      { id: '1', name: 'a', status: 'active', proxy: 'http://p1:1' },
      { id: '2', name: 'b', status: 'active', proxy: 'http://p2:2' },
    ];
    const { pool, db } = poolWith(duo);
    const multi = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: ['a', 'b'] },
      'like',
      async () => 'ok',
      { capability: 'write', sequential: true },
    );
    expect(multi.every((r) => r.success)).toBe(true);

    const solo = [{ id: 's', name: 'solo', status: 'active', proxy: null }];
    const soloCtx = poolWith(solo);
    const one = await executeWithMultipleAccounts(
      soloCtx.pool,
      soloCtx.db,
      { accounts: ['solo'] },
      'like',
      async () => 'ok',
      { capability: 'write' },
    );
    expect(one[0].success).toBe(true);
  });

  it('warn 模式缺 proxy 仍执行', async () => {
    cfg.antiDetect.proxyRequired.mode = 'warn';
    const accts = [
      { id: '1', name: 'a', status: 'active', proxy: null },
      { id: '2', name: 'b', status: 'active', proxy: null },
    ];
    const { pool, db } = poolWith(accts);
    const results = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: ['a', 'b'] },
      'like',
      async () => 'ok',
      { capability: 'write', sequential: true },
    );
    expect(results.every((r) => r.success)).toBe(true);
  });
});

describe('A2 互动目标 dedup + 键空间统一（跨路径互斥）', () => {
  beforeAll(() => {
    cfg.antiDetect.liveness.enabled = false;
    cfg.antiDetect.headlessWriteGate.enabled = false;
    cfg.antiDetect.quota.enabled = false;
    cfg.antiDetect.cooccurrence.enabled = false;
    cfg.antiDetect.proxyRequired.mode = 'off';
    cfg.browser.headless = false;
  });
  beforeEach(() => getCooccurrenceGuard().reset());

  function poolWith(accts: Array<{ id: string; name: string; status: string }>) {
    const pool: any = {
      getAccount: (key: string) => accts.find((a) => a.name === key || a.id === key) ?? null,
      acquireLock: async () => () => {},
      getClient: async () => ({ fake: true }),
      touchAccount: () => {},
      listAccounts: () => accts,
    };
    const db: any = { operations: { log: () => {} } };
    return { pool: pool as unknown as AccountPool, db: db as unknown as XhsDatabase };
  }

  it('账号 A explore 风格 like:note:X 提交后，账号 B 工具 like 同键被 cross_account_dedup 拦截', async () => {
    const guard = getCooccurrenceGuard();
    // 模拟 explore.ts 内部写路径：直接调用 guard（同进程内共享同一守卫单例）
    const resv = await guard.beforeAction({ accountId: 'acc-A', action: 'like', dedupKey: 'like:note:X' });
    expect(resv.allow).toBe(true);
    await guard.afterAction({
      accountId: 'acc-A',
      action: 'like',
      success: true,
      dedupKey: 'like:note:X',
      reservation: resv.reservation,
    });

    // 模拟 tools/interaction.ts 的 xhs_like_feed 工具路径：走 executeWithAccount，
    // dedupKey 与 explore 侧统一为 like:note:${noteId}
    const accts = [{ id: 'B', name: 'acc-B', status: 'active' }];
    const { pool, db } = poolWith(accts);
    const res = await executeWithAccount(pool, db, 'acc-B', 'like', async () => ({ success: true }), {
      capability: 'write',
      dedupKey: 'like:note:X',
    });
    expect(res.success).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.error).toBe('cross_account_dedup');
  });

  it('like_c 键空间统一：explore 内部点赞评论提交后，工具 like_comment 同键跨账号被拦截', async () => {
    const guard = getCooccurrenceGuard();
    const resv = await guard.beforeAction({
      accountId: 'acc-A',
      action: 'like_comment',
      dedupKey: 'like_c:noteX:commentY',
    });
    expect(resv.allow).toBe(true);
    await guard.afterAction({
      accountId: 'acc-A',
      action: 'like_comment',
      success: true,
      dedupKey: 'like_c:noteX:commentY',
      reservation: resv.reservation,
    });

    const accts = [{ id: 'B', name: 'acc-B', status: 'active' }];
    const { pool, db } = poolWith(accts);
    const res = await executeWithAccount(pool, db, 'acc-B', 'like_comment', async () => ({ success: true }), {
      capability: 'write',
      dedupKey: 'like_c:noteX:commentY',
    });
    expect(res.success).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.error).toBe('cross_account_dedup');
  });

  it('like/unlike 共用同一目标键：unlike 使用与 like 相同的 dedupKey 时同样受跨账号去重约束', async () => {
    const guard = getCooccurrenceGuard();
    const resv = await guard.beforeAction({ accountId: 'acc-A', action: 'like', dedupKey: 'like:note:Y' });
    await guard.afterAction({
      accountId: 'acc-A',
      action: 'like',
      success: true,
      dedupKey: 'like:note:Y',
      reservation: resv.reservation,
    });

    // 账号 B 尝试对同一 noteId 的 unlike 操作（沿用相同 dedupKey）应同样被拦截
    const accts = [{ id: 'B', name: 'acc-B', status: 'active' }];
    const { pool, db } = poolWith(accts);
    const res = await executeWithAccount(pool, db, 'acc-B', 'unlike', async () => ({ success: true }), {
      capability: 'write',
      dedupKey: 'like:note:Y',
    });
    expect(res.success).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.error).toBe('cross_account_dedup');
  });
});

describe('A6 拒绝单次同 note 多账号写', () => {
  beforeAll(() => {
    cfg.antiDetect.liveness.enabled = false;
    cfg.antiDetect.headlessWriteGate.enabled = false;
    cfg.antiDetect.quota.enabled = false;
    cfg.antiDetect.cooccurrence.enabled = false;
    cfg.antiDetect.proxyRequired.mode = 'off';
    cfg.browser.headless = false;
  });
  beforeEach(() => getCooccurrenceGuard().reset());

  function poolWith(accts: Array<{ id: string; name: string; status: string }>) {
    const pool: any = {
      getAccount: (key: string) => accts.find((a) => a.name === key || a.id === key) ?? null,
      acquireLock: async () => () => {},
      getClient: async () => ({ fake: true }),
      touchAccount: () => {},
      listAccounts: () => accts,
    };
    const db: any = { operations: { log: () => {} } };
    return { pool: pool as unknown as AccountPool, db: db as unknown as XhsDatabase };
  }

  it('accounts 数组长度 > 1 且携带同一 noteId → 整批拒绝，不执行任何账号', async () => {
    const accts = [
      { id: '1', name: 'a', status: 'active' },
      { id: '2', name: 'b', status: 'active' },
    ];
    const { pool, db } = poolWith(accts);
    let ran = 0;
    const results = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: ['a', 'b'] },
      'like',
      async () => {
        ran += 1;
        return { success: true };
      },
      { capability: 'write', sequential: true, noteId: 'same-note' },
    );
    expect(ran).toBe(0);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.skipped && r.error === 'multi_account_same_note_rejected:same-note')).toBe(true);
  });

  it("accounts:'all' 解析后 > 1 账号且同一 noteId → 同样整批拒绝", async () => {
    const accts = [
      { id: '1', name: 'a', status: 'active' },
      { id: '2', name: 'b', status: 'active' },
      { id: '3', name: 'c', status: 'suspended' },
    ];
    const { pool, db } = poolWith(accts);
    let ran = 0;
    const results = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: 'all' },
      'favorite',
      async () => {
        ran += 1;
        return { success: true };
      },
      { capability: 'write', sequential: true, noteId: 'note-all' },
    );
    expect(ran).toBe(0);
    // 'all' 仅解析活跃账号（a、b），不含 suspended 的 c
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error === 'multi_account_same_note_rejected:note-all')).toBe(true);
  });

  it('单账号（含数组长度为 1）携带 noteId 不受影响，正常执行', async () => {
    const accts = [{ id: '1', name: 'a', status: 'active' }];
    const { pool, db } = poolWith(accts);
    let ran = 0;
    const results = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: ['a'] },
      'like',
      async () => {
        ran += 1;
        return { success: true };
      },
      { capability: 'write', noteId: 'solo-note' },
    );
    expect(ran).toBe(1);
    expect(results[0].success).toBe(true);
  });

  it('未提供 noteId 时，多账号批次不受 A6 影响（仅其他门禁生效）', async () => {
    const accts = [
      { id: '1', name: 'a', status: 'active' },
      { id: '2', name: 'b', status: 'active' },
    ];
    const { pool, db } = poolWith(accts);
    let ran = 0;
    const results = await executeWithMultipleAccounts(
      pool,
      db,
      { accounts: ['a', 'b'] },
      'like',
      async () => {
        ran += 1;
        return { success: true };
      },
      { capability: 'write', sequential: true },
    );
    expect(ran).toBe(2);
    expect(results.every((r) => r.success)).toBe(true);
  });
});
