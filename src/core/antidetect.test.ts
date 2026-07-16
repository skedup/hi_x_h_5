/**
 * @fileoverview 反检测守卫单元测试（离线、无需真实账号）。
 * 覆盖 C2.1–C2.4：账号间冷却、跨账号去重、中央限额/熔断、xsecToken 绑定。
 * @module core/antidetect.test
 */
import { describe, it, expect } from 'bun:test';
import { CooccurrenceGuard } from './antidetect.js';

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
  it('相同去重键被其他账号占用则拦截，同账号放行', () => {
    const g = new CooccurrenceGuard(makeCfg());
    expect(g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' }).allow).toBe(true);
    g.afterAction({ accountId: A, action: 'comment', success: true, dedupKey: 'k' });
    // 其他账号被拦截
    expect(g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k' }).allow).toBe(false);
    // 原账号仍放行
    expect(g.beforeAction({ accountId: A, action: 'comment', dedupKey: 'k' }).allow).toBe(true);
  });
  it('禁用去重时不拦截', () => {
    const g = new CooccurrenceGuard(makeCfg({ dedup: { enabled: false } }));
    g.afterAction({ accountId: A, action: 'comment', success: true, dedupKey: 'k' });
    expect(g.beforeAction({ accountId: B, action: 'comment', dedupKey: 'k' }).allow).toBe(true);
  });
});

describe('C2.3 中央限额/熔断', () => {
  it('超过每小时预算则拦截', () => {
    const g = new CooccurrenceGuard(makeCfg());
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(true);
    g.afterAction({ accountId: A, action: 'like', success: true });
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(true);
    g.afterAction({ accountId: A, action: 'like', success: true });
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(false);
  });
  it('动作后冷却中拦截', () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 10_000, consecutiveFailuresToTrip: 99, captchaErrorPatterns: [] } }));
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(true);
    g.afterAction({ accountId: A, action: 'like', success: true });
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(false);
  });
  it('命中验证码关键字即熔断', () => {
    const g = new CooccurrenceGuard(makeCfg());
    g.afterAction({ accountId: A, action: 'like', success: false, error: '出现验证码，请完成验证' });
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(false);
  });
  it('连续失败达阈值熔断', () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 2, captchaErrorPatterns: [] } }));
    g.afterAction({ accountId: A, action: 'like', success: false, error: 'network' });
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(true);
    g.afterAction({ accountId: A, action: 'like', success: false, error: 'network' });
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(false);
  });
  it('成功重置连续失败计数', () => {
    const g = new CooccurrenceGuard(makeCfg({ quota: { enabled: true, perAccountHourly: 99, perAccountDaily: 99, cooldownMsAfterAction: 0, consecutiveFailuresToTrip: 2, captchaErrorPatterns: [] } }));
    g.afterAction({ accountId: A, action: 'like', success: false, error: 'e' });
    g.afterAction({ accountId: A, action: 'like', success: true });
    g.afterAction({ accountId: A, action: 'like', success: false, error: 'e' });
    expect(g.beforeAction({ accountId: A, action: 'like' }).allow).toBe(true);
  });
});

describe('C2.2 xsecToken 绑定', () => {
  it('warn 模式：跨账号复用放行但记录', () => {
    const g = new CooccurrenceGuard(makeCfg({ xsecTokenBinding: { enabled: true, mode: 'warn' } }));
    expect(g.beforeAction({ accountId: A, action: 'like', xsecToken: 'tok' }).allow).toBe(true);
    g.afterAction({ accountId: A, action: 'like', success: true, xsecToken: 'tok' });
    expect(g.beforeAction({ accountId: B, action: 'like', xsecToken: 'tok' }).allow).toBe(true);
  });
  it('block 模式：跨账号复用直接拦截', () => {
    const g = new CooccurrenceGuard(makeCfg({ xsecTokenBinding: { enabled: true, mode: 'block' } }));
    expect(g.beforeAction({ accountId: A, action: 'like', xsecToken: 'tok' }).allow).toBe(true);
    g.afterAction({ accountId: A, action: 'like', success: true, xsecToken: 'tok' });
    const r = g.beforeAction({ accountId: B, action: 'like', xsecToken: 'tok' });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('xsec_token_bound_to_other_account');
  });
});

describe('reset', () => {
  it('重置后状态清空', () => {
    const g = new CooccurrenceGuard(makeCfg());
    g.afterAction({ accountId: A, action: 'like', success: true, dedupKey: 'k', xsecToken: 't' });
    g.reset();
    expect(g.beforeAction({ accountId: B, action: 'like', dedupKey: 'k', xsecToken: 't' }).allow).toBe(true);
  });
});
