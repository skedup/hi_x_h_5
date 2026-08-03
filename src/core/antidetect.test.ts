/**
 * @fileoverview 反检测守卫单元测试（离线、无需真实账号）。
 * 覆盖 C2.1–C2.4：账号间冷却、跨账号去重、中央限额/熔断、xsecToken 绑定。
 * beforeAction/afterAction 为异步（原子预占+回滚，蓝军 #4/#5），测试内统一 await。
 * @module core/antidetect.test
 */
import { describe, it, expect } from 'bun:test';
import { CooccurrenceGuard, sha256OfText } from './antidetect.js';

// 构造一个确定性的测试配置
function makeCfg(overrides: any = {}) {
  return {
    cooccurrence: {
      enabled: true,
      sequential: true,
      interAccountCooldownMs: [100, 300] as [number, number],
      ...(overrides.cooccurrence || {}),
    },
    xsecTokenBinding: {
      enabled: true,
      mode: (overrides.xsecTokenBinding?.mode || 'warn') as 'block' | 'warn',
      ...(overrides.xsecTokenBinding || {}),
    },
    quota: {
      enabled: true,
      perAccountHourly: 2,
      perAccountDaily: 5,
      cooldownMsAfterAction: 0,
      consecutiveFailuresToTrip: 2,
      captchaErrorPatterns: ['验证码', 'captcha', '429'],
      ...(overrides.quota || {}),
    },
    dedup: {
      enabled: true,
      ...(overrides.dedup || {}),
    },
    liveness: {
      enabled: true,
      pollIntervalMs: 15000,
      idleTimeoutMs: 0,
      ...(overrides.liveness || {}),
    },
    headlessWriteGate: {
      enabled: true,
      ...(overrides.headlessWriteGate || {}),
    },
    persist: {
      enabled: false,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      ...(overrides.persist || {}),
    },
    proxyRequired: {
      mode: 'off' as const,
      ...(overrides.proxyRequired || {}),
    },
    heavyTail: {
      enabled: true,
      sigma: 0.45,
      maxMultiplier: 8,
      ...(overrides.heavyTail || {}),
    },
  };
}

const A = 'acc1';
const B = 'acc2';

describe('C2.1 账号间冷却', () => {
  it('启用时返回区间内随机值', () => {
    const g = new CooccurrenceGuard(makeCfg());
    for (let i = 0; i < 20; i++) {
      const v = g.interAccountCooldownMs();
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThan(300);
    }
  });
  it('禁用时返回 0', () => {
    const g = new CooccurrenceGuard(makeCfg({ cooccurrence: { enabled: false, sequential: true, interAccountCooldownMs: [100, 300] } }));
    expect(g.interAccountCooldownMs()).toBe(0);
  });
});

describe('C2.4 跨账号去重', () => {
  it('相同去重键被其他账号占用则拦截，同账号放行', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    // 首次使用即原子预占去重键，无需等 afterAction（蓝军 #4）
    expect((await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' })).allow).toBe(true);
    // 其他账号被拦截
    expect((await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k' })).allow).toBe(false);
    // 原账号仍放行
    expect((await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' })).allow).toBe(true);
  });
  it('禁用去重时不拦截', async () => {
    const g = new CooccurrenceGuard(makeCfg({ dedup: { enabled: false } }));
    expect((await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k' })).allow).toBe(true);
  });
});

describe('C2.3 中央限额/熔断', () => {
  it('超过每小时预算则拦截', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(true);
    await g.afterAction({ accountId: A, action: 'like', success: true });
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(true);
    await g.afterAction({ accountId: A, action: 'like', success: true });
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(false);
  });
  it('动作后冷却中拦截', async () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 10_000, consecutiveFailuresToTrip: 99, captchaErrorPatterns: [] } }));
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(true);
    await g.afterAction({ accountId: A, action: 'like', success: true });
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(false);
  });
  it('命中验证码关键字即熔断', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    await g.afterAction({ accountId: A, action: 'like', success: false, error: '出现验证码，请完成验证' });
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(false);
  });
  it('连续失败达阈值熔断', async () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 2, captchaErrorPatterns: [] } }));
    await g.afterAction({ accountId: A, action: 'like', success: false, error: 'network' });
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(true);
    await g.afterAction({ accountId: A, action: 'like', success: false, error: 'network' });
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(false);
  });
  it('成功重置连续失败计数', async () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 2, captchaErrorPatterns: [] } }));
    await g.afterAction({ accountId: A, action: 'like', success: false, error: 'e' });
    await g.afterAction({ accountId: A, action: 'like', success: true });
    await g.afterAction({ accountId: A, action: 'like', success: false, error: 'e' });
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(true);
  });
  it('执行失败回滚预算计数（蓝军 #5）', async () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 1, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 99, captchaErrorPatterns: [] } }));
    await g.afterAction({ accountId: A, action: 'like', success: false, error: 'boom' });
    // 预算已回滚，下一次仍允许
    expect((await g.beforeAction({ accountId: A, action: 'like' })).allow).toBe(true);
  });
  it('业务失败（验证码但 HTTP 成功）也触发熔断（蓝军 #5）', async () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 99, captchaErrorPatterns: ['验证码'] } }));
    const r = await g.afterAction({ accountId: A, action: 'like', success: true, result: { needVerify: true } });
    expect(r.trippedNow).toBe(true);
    expect(g.isTripped(A)).toBe(true);
  });
});

describe('C2.2 xsecToken 绑定', () => {
  it('warn 模式：跨账号复用放行但记录', async () => {
    const g = new CooccurrenceGuard(makeCfg({ xsecTokenBinding: { enabled: true, mode: 'warn' } }));
    expect((await g.beforeAction({ accountId: A, action: 'like', xsecToken: 'tok' })).allow).toBe(true);
    await g.afterAction({ accountId: A, action: 'like', success: true, xsecToken: 'tok' });
    expect((await g.beforeAction({ accountId: B, action: 'like', xsecToken: 'tok' })).allow).toBe(true);
  });
  it('block 模式：跨账号复用直接拦截', async () => {
    const g = new CooccurrenceGuard(makeCfg({ xsecTokenBinding: { enabled: true, mode: 'block' } }));
    expect((await g.beforeAction({ accountId: A, action: 'like', xsecToken: 'tok' })).allow).toBe(true);
    await g.afterAction({ accountId: A, action: 'like', success: true, xsecToken: 'tok' });
    const r = await g.beforeAction({ accountId: B, action: 'like', xsecToken: 'tok' });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('xsec_token_bound_to_other_account');
  });
  it('蓝军 #6 来源绑定：A 提取的 token 被 B 写操作使用时 fail-closed 拦截', async () => {
    const g = new CooccurrenceGuard(makeCfg({ xsecTokenBinding: { enabled: true, mode: 'block' } }));
    g.bindXsecSource('tok', A);
    // A 同源写放行
    expect((await g.beforeAction({ accountId: A, action: 'comment', xsecToken: 'tok' })).allow).toBe(true);
    // B 跨账号使用被拦截（而非「谁先写归谁」）
    const r = await g.beforeAction({ accountId: B, action: 'comment', xsecToken: 'tok' });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('xsec_token_bound_to_other_account');
  });
  it('蓝军 #6 首个提取者占用来源，后续提取不抢占', async () => {
    const g = new CooccurrenceGuard(makeCfg({ xsecTokenBinding: { enabled: true, mode: 'block' } }));
    g.bindXsecSource('tok', A);
    g.bindXsecSource('tok', B); // B 抢占无效
    expect(g.isTripped(B)).toBe(false);
    expect((await g.beforeAction({ accountId: B, action: 'comment', xsecToken: 'tok' })).allow).toBe(false);
    expect((await g.beforeAction({ accountId: A, action: 'comment', xsecToken: 'tok' })).allow).toBe(true);
  });
});

describe('R2-9 失败精确回滚预占', () => {
  it('执行失败时回滚本次新占用的去重键与 token，避免永久锁死', async () => {
    const g = new CooccurrenceGuard(
      makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 99, captchaErrorPatterns: [] } }),
    );
    const b1 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k', xsecToken: 't' });
    expect(b1.allow).toBe(true);
    expect(b1.reservation?.dedupKey).toBe('k');
    expect(b1.reservation?.xsecToken).toBe('t');
    // 执行失败 → 回滚本次新占用
    await g.afterAction({ accountId: A, action: 'comment', success: false, dedupKey: 'k', xsecToken: 't', reservation: b1.reservation });
    // 回滚后 B 可占用同一 dedupKey/token（非永久锁死）
    expect((await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k', xsecToken: 't' })).allow).toBe(true);
  });
  it('执行成功不回滚占用（内容已落库，去重应保持）', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    const b1 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k2' });
    await g.afterAction({ accountId: A, action: 'comment', success: true, dedupKey: 'k2', reservation: b1.reservation });
    expect((await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k2' })).allow).toBe(false);
  });
});

describe('reset', () => {
  it('重置后状态清空', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    await g.afterAction({ accountId: A, action: 'like', success: true, dedupKey: 'k', xsecToken: 't' });
    g.reset();
    expect((await g.beforeAction({ accountId: B, action: 'like', dedupKey: 'k', xsecToken: 't' })).allow).toBe(true);
  });
});

describe('R4 软业务失败与并发占用状态机', () => {
  it('P1 1019897593 软业务失败（success:true, result.success:false）不提交去重且回滚预算', async () => {
    const g = new CooccurrenceGuard(
      makeCfg({ quota: { enabled: true, perAccountHourly: 1, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 99, captchaErrorPatterns: [] } }),
    );
    const b1 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' });
    await g.afterAction({ accountId: A, action: 'comment', success: true, result: { success: false }, dedupKey: 'k', reservation: b1.reservation });
    // 去重未提交：B 可使用同 key（不触发 cross_account_dedup）
    expect((await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k' })).allow).toBe(true);
    // 预算已回滚：A 仍可在每小时预算内再次动作
    expect((await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k2' })).allow).toBe(true);
  });

  it('P1 1019970087 同账号并发：A2 成功 + A1 失败（乱序）→ key 提交，B 不可复用', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    const b1 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' });
    const b2 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' });
    // A2 成功（先提交）
    await g.afterAction({ accountId: A, action: 'comment', success: true, dedupKey: 'k', reservation: b2.reservation });
    // A1 失败（后完成，乱序）
    await g.afterAction({ accountId: A, action: 'comment', success: false, dedupKey: 'k', reservation: b1.reservation });
    // 因 A2 成功，key 已提交，B 不可复用
    expect((await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k' })).allow).toBe(false);
  });

  it('P1 1019970087 同账号并发：两者均失败 → key 回收，B 可复用', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    const b1 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' });
    const b2 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' });
    await g.afterAction({ accountId: A, action: 'comment', success: false, dedupKey: 'k', reservation: b2.reservation });
    await g.afterAction({ accountId: A, action: 'comment', success: false, dedupKey: 'k', reservation: b1.reservation });
    // 全部失败 → 占用回收，B 可复用
    expect((await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k' })).allow).toBe(true);
  });
});

describe('A4 · comment_text 正文哈希键跨路径互斥（explore ↔ tools/interaction.ts）', () => {
  // explore.ts 内部评论与 tools/interaction.ts 的 xhs_post_comment 均使用
  // `comment_text:${sha256OfText(content)}` 作为 dedupKey（同一前缀+算法），
  // 使两条路径对「相同文案」天然共用同一去重键空间，无需关心 noteId 是否相同。
  const buildDedupKey = (content: string) => `comment_text:${sha256OfText(content)}`;

  it('账号 A 用 explore 内部评论提交某文案后，账号 B 用工具接口发相同文案（不同 note）被拦截', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    const sameText = '这条笔记真不错，学到了！';

    // 模拟 explore.ts：账号 A 在 noteId=note-1 上生成并提交该评论文案
    const explore = await g.beforeAction({
      accountId: A,
      action: 'comment',
      dedupKey: buildDedupKey(sameText),
      xsecToken: 'tok-note-1',
    });
    expect(explore.allow).toBe(true);
    await g.afterAction({
      accountId: A,
      action: 'comment',
      success: true,
      dedupKey: buildDedupKey(sameText),
      xsecToken: 'tok-note-1',
      reservation: explore.reservation,
    });

    // 模拟 tools/interaction.ts 的 xhs_post_comment：账号 B 在完全不同的 noteId 上发相同文案
    const tool = await g.beforeAction({
      accountId: B,
      action: 'comment',
      dedupKey: buildDedupKey(sameText),
      xsecToken: 'tok-note-2-completely-different',
    });
    expect(tool.allow).toBe(false);
    expect(tool.reason).toBe('cross_account_dedup');
  });

  it('文案不同（哈希不同）则不互斥，账号 B 可正常发布', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    const explore = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: buildDedupKey('文案甲') });
    await g.afterAction({ accountId: A, action: 'comment', success: true, dedupKey: buildDedupKey('文案甲'), reservation: explore.reservation });

    const tool = await g.beforeAction({ accountId: B, action: 'comment', dedupKey: buildDedupKey('文案乙') });
    expect(tool.allow).toBe(true);
  });

  it('同账号跨路径（explore 与工具）复用相同文案时放行（去重仅跨账号）', async () => {
    const g = new CooccurrenceGuard(makeCfg());
    const sameText = '同一账号重复使用的文案';
    const explore = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: buildDedupKey(sameText) });
    await g.afterAction({ accountId: A, action: 'comment', success: true, dedupKey: buildDedupKey(sameText), reservation: explore.reservation });

    const tool = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: buildDedupKey(sameText) });
    expect(tool.allow).toBe(true);
  });
});

describe('R5 token 与取消状态机', () => {
  it('同账号 token 并发：A2 成功 + A1 失败后仍保留来源绑定', async () => {
    const g = new CooccurrenceGuard(
      makeCfg({
        xsecTokenBinding: { enabled: true, mode: 'block' },
        quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0 },
      }),
    );
    const b1 = await g.beforeAction({ accountId: A, action: 'comment', xsecToken: 'tok-r5' });
    const b2 = await g.beforeAction({ accountId: A, action: 'comment', xsecToken: 'tok-r5' });

    expect(b1.reservation?.xsecToken).toBe('tok-r5');
    expect(b2.reservation?.xsecToken).toBe('tok-r5');
    await g.afterAction({ accountId: A, action: 'comment', success: true, reservation: b2.reservation });
    await g.afterAction({ accountId: A, action: 'comment', success: false, reservation: b1.reservation });

    const other = await g.beforeAction({ accountId: B, action: 'comment', xsecToken: 'tok-r5' });
    expect(other.allow).toBe(false);
    expect(other.reason).toBe('xsec_token_bound_to_other_account');
  });

  it('并发中一次成功、另一次取消时仍提交 dedup key', async () => {
    const g = new CooccurrenceGuard(
      makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0 } }),
    );
    const b1 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'cancel-after-success' });
    const b2 = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'cancel-after-success' });

    await g.afterAction({ accountId: A, action: 'comment', success: true, reservation: b2.reservation });
    await g.cancelReservation(b1.reservation, A);

    const other = await g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'cancel-after-success' });
    expect(other.allow).toBe(false);
    expect(other.reason).toBe('cross_account_dedup');
  });

  it('取消 reservation 后退回预算，但保留冷却语义之外的重试额度', async () => {
    const g = new CooccurrenceGuard(
      makeCfg({
        quota: {
          enabled: true,
          perAccountHourly: 1,
          perAccountDaily: 1,
          cooldownMsAfterAction: 0,
          consecutiveFailuresToTrip: 99,
          captchaErrorPatterns: [],
        },
      }),
    );
    const before = await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'cancel-budget' });
    await g.cancelReservation(before.reservation, A);

    expect((await g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'retry-after-cancel' })).allow).toBe(true);
  });
});

/** A5：内存假 store，模拟 SQLite 持久化（bun 不支持 better-sqlite3） */
function makeMemoryPersistStore() {
  const dedups = new Map<string, { account_id: string; created_at: number; expires_at: number }>();
  const tokens = new Map<string, { account_id: string; created_at: number; expires_at: number }>();
  return {
    upsertDedup(dedupKey: string, accountId: string, createdAt: number, expiresAt: number) {
      dedups.set(dedupKey, { account_id: accountId, created_at: createdAt, expires_at: expiresAt });
    },
    upsertToken(tokenHash: string, accountId: string, createdAt: number, expiresAt: number) {
      tokens.set(tokenHash, { account_id: accountId, created_at: createdAt, expires_at: expiresAt });
    },
    loadActiveDedups(nowMs: number) {
      return [...dedups.entries()]
        .filter(([, v]) => v.expires_at > nowMs)
        .map(([dedup_key, v]) => ({ dedup_key, ...v }));
    },
    loadActiveTokens(nowMs: number) {
      return [...tokens.entries()]
        .filter(([, v]) => v.expires_at > nowMs)
        .map(([token_hash, v]) => ({ token_hash, ...v }));
    },
    deleteExpired(nowMs: number) {
      let n = 0;
      for (const [k, v] of dedups) {
        if (v.expires_at <= nowMs) {
          dedups.delete(k);
          n++;
        }
      }
      for (const [k, v] of tokens) {
        if (v.expires_at <= nowMs) {
          tokens.delete(k);
          n++;
        }
      }
      return n;
    },
    clearAll() {
      dedups.clear();
      tokens.clear();
    },
    _dedups: dedups,
    _tokens: tokens,
  };
}

describe('A5 Guard 持久化（杀进程后仍拦截）', () => {
  it('工具赞提交后，新 Guard 实例加载同一 store → explore 同键跨账号被拦', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: true, ttlMs: 86_400_000 },
      xsecTokenBinding: { mode: 'block' },
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const g1 = new CooccurrenceGuard(cfg);
    g1.attachPersistence(store);
    const r = await g1.beforeAction({ accountId: A, action: 'like', dedupKey: 'like:note:X' });
    await g1.afterAction({ accountId: A, action: 'like', success: true, reservation: r.reservation });
    expect(store._dedups.has('like:note:X')).toBe(true);

    // 模拟杀进程：全新 Guard + 同一 store
    const g2 = new CooccurrenceGuard(cfg);
    g2.attachPersistence(store);
    const blocked = await g2.beforeAction({ accountId: B, action: 'like', dedupKey: 'like:note:X' });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe('cross_account_dedup');
  });

  it('comment_text 跨帖键持久化后跨实例仍互斥', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: true, ttlMs: 86_400_000 },
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const key = `comment_text:${sha256OfText('同一句文案')}`;
    const g1 = new CooccurrenceGuard(cfg);
    g1.attachPersistence(store);
    const r = await g1.beforeAction({ accountId: A, action: 'comment', dedupKey: key });
    await g1.afterAction({ accountId: A, action: 'comment', success: true, reservation: r.reservation });

    const g2 = new CooccurrenceGuard(cfg);
    g2.attachPersistence(store);
    const blocked = await g2.beforeAction({ accountId: B, action: 'comment', dedupKey: key });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe('cross_account_dedup');
  });

  it('bindXsecSource 落库后新实例仍拦截跨账号写', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: true, ttlMs: 86_400_000 },
      xsecTokenBinding: { mode: 'block' },
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const g1 = new CooccurrenceGuard(cfg);
    g1.attachPersistence(store);
    g1.bindXsecSource('raw-token-abc', A);
    expect(store._tokens.has(sha256OfText('raw-token-abc'))).toBe(true);

    const g2 = new CooccurrenceGuard(cfg);
    g2.attachPersistence(store);
    const blocked = await g2.beforeAction({ accountId: B, action: 'like', xsecToken: 'raw-token-abc' });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe('xsec_token_bound_to_other_account');
  });

  it('clearPersistent 清空库与内存后放行', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: true, ttlMs: 86_400_000 },
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const g = new CooccurrenceGuard(cfg);
    g.attachPersistence(store);
    const r = await g.beforeAction({ accountId: A, action: 'like', dedupKey: 'like:note:Z' });
    await g.afterAction({ accountId: A, action: 'like', success: true, reservation: r.reservation });
    g.clearPersistent();
    expect(store._dedups.size).toBe(0);
    expect((await g.beforeAction({ accountId: B, action: 'like', dedupKey: 'like:note:Z' })).allow).toBe(true);
  });

  it('过期行在 load 时被 GC，不再拦截', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: true, ttlMs: 1 }, // 1ms TTL
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const g1 = new CooccurrenceGuard(cfg);
    g1.attachPersistence(store);
    const r = await g1.beforeAction({ accountId: A, action: 'like', dedupKey: 'like:note:ttl' });
    await g1.afterAction({ accountId: A, action: 'like', success: true, reservation: r.reservation });
    await new Promise((res) => setTimeout(res, 5));

    const g2 = new CooccurrenceGuard(cfg);
    g2.attachPersistence(store);
    expect((await g2.beforeAction({ accountId: B, action: 'like', dedupKey: 'like:note:ttl' })).allow).toBe(true);
  });

  it('同进程内 TTL 到期后惰性过期放行（不依赖重启）', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: true, ttlMs: 1 },
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const g = new CooccurrenceGuard(cfg);
    g.attachPersistence(store);
    const r = await g.beforeAction({ accountId: A, action: 'like', dedupKey: 'like:note:live-ttl' });
    await g.afterAction({ accountId: A, action: 'like', success: true, reservation: r.reservation });
    expect((await g.beforeAction({ accountId: B, action: 'like', dedupKey: 'like:note:live-ttl' })).allow).toBe(
      false,
    );
    await new Promise((res) => setTimeout(res, 5));
    expect((await g.beforeAction({ accountId: B, action: 'like', dedupKey: 'like:note:live-ttl' })).allow).toBe(
      true,
    );
  });

  it('reset 在持久化开启时从库回填 committed，不留下拦截空洞', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: true, ttlMs: 86_400_000 },
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const g = new CooccurrenceGuard(cfg);
    g.attachPersistence(store);
    const r = await g.beforeAction({ accountId: A, action: 'like', dedupKey: 'like:note:reset' });
    await g.afterAction({ accountId: A, action: 'like', success: true, reservation: r.reservation });
    g.reset(); // 应重新从 store 加载
    const blocked = await g.beforeAction({ accountId: B, action: 'like', dedupKey: 'like:note:reset' });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe('cross_account_dedup');
  });

  it('persist.enabled=false 时不写库', async () => {
    const store = makeMemoryPersistStore();
    const cfg = makeCfg({
      persist: { enabled: false, ttlMs: 86_400_000 },
      quota: { enabled: false, cooldownMsAfterAction: 0 },
    });
    const g = new CooccurrenceGuard(cfg);
    g.attachPersistence(store);
    const r = await g.beforeAction({ accountId: A, action: 'like', dedupKey: 'like:note:off' });
    await g.afterAction({ accountId: A, action: 'like', success: true, reservation: r.reservation });
    expect(store._dedups.size).toBe(0);
  });
});
