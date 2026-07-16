/**
 * @fileoverview 反检测：多账号共现抑制守卫（波次 C / C2）。
 *
 * 集中实现四个子项，全部通过 config.antiDetect.* 开关独立可回滚：
 * - C2.1 串行 + 账号间随机抖动（消除 ms/秒级同步尖峰）
 * - C2.2 xsecToken 绑定（禁止跨账号复用同一 token，block/warn 两模式）
 * - C2.3 中央限额/熔断（每账号小时/日预算、动作后冷却、连续失败/验证码熔断进入人工）
 * - C2.4 跨账号 content/media 去重（相同评论正文 / 相同媒体哈希硬拦截）
 *
 * 调用点统一为 core/multi-account.ts 的 executeWithAccount / executeWithMultipleAccounts，
 * 因此本模块是写行为的唯一共现控制汇聚点。
 * @module core/antidetect
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createLogger } from './logger.js';
import { config } from './config.js';

const log = createLogger('antidetect');

/**
 * 在 [min, max) 内取随机整数（含 min，不含 max）。
 */
export function randomBetween(min: number, max: number): number {
  if (!(max > min)) return min;
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * 动作前核查入参。
 */
export interface BeforeActionInput {
  /** 账号 ID */
  accountId: string;
  /** 动作名（用于日志/预算） */
  action: string;
  /** 跨账号去重键（C2.4）；不传表示不对此动作做去重 */
  dedupKey?: string;
  /** 该账号意图使用的 xsecToken（C2.2 绑定检测） */
  xsecToken?: string;
}

/**
 * 动作后回填入参。
 */
export interface AfterActionInput {
  accountId: string;
  action: string;
  success: boolean;
  error?: string;
  result?: any;
  dedupKey?: string;
  xsecToken?: string;
}

/**
 * 多账号共现抑制守卫（进程内单例）。
 */
/** 简单异步互斥锁：保证 policy 检查/预占的原子性（蓝军 #4） */
class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class CooccurrenceGuard {
  // 预算窗口：账号 -> { 计数, 重置时间 }
  private hourly = new Map<string, { count: number; resetAt: number }>();
  private daily = new Map<string, { count: number; resetAt: number }>();
  // 单账号上次动作时间（用于动作后冷却）
  private lastActionAt = new Map<string, number>();
  // 熔断集合（进入人工，停止该账号后续动作）
  private tripped = new Set<string>();
  // 每账号连续失败计数
  private consecutiveFailures = new Map<string, number>();
  // 去重登记：去重键 -> 首个使用的账号
  private dedupSeen = new Map<string, string>();
  // xsecToken 绑定：token -> 首个使用的账号
  private tokenBindings = new Map<string, string>();
  /** 蓝军 #4：检查/预占的全局 policy 互斥锁 */
  private policyMutex = new AsyncMutex();

  constructor(private cfg = config.antiDetect) {}

  /** C2.1 是否启用共现抑制（串行） */
  isCooccurrenceEnabled(): boolean {
    return this.cfg.cooccurrence.enabled;
  }

  /** C2.1 账号间随机冷却毫秒；非串行或未启用则返回 0 */
  interAccountCooldownMs(): number {
    if (!this.cfg.cooccurrence.enabled || !this.cfg.cooccurrence.sequential) return 0;
    const [min, max] = this.cfg.cooccurrence.interAccountCooldownMs;
    return randomBetween(min, max);
  }

  /**
   * C2.1/C2.2/C2.3/C2.4 动作前核查 + 原子预占。
   * 在 policyMutex 内完成「检查 → 预占」，保证并发账号不会同时越过预算/冷却/去重/xsec 绑定
   * （蓝军 #4：原实现检查与预占分离，存在 TOCTOU 双计/越限风险）。
   * 仅对 write 能力的动作调用（read/control 在调用方已短路，见 #3）。
   * @returns allow=false 时携带 reason（skip 原因），调用方应跳过该账号动作。
   */
  async beforeAction(input: BeforeActionInput): Promise<{ allow: boolean; reason?: string }> {
    return this.policyMutex.run(async () => {
      const q = this.cfg.quota;
      const d = this.cfg.dedup;

      // C2.3 熔断：已熔断账号直接跳过
      if (q.enabled && this.tripped.has(input.accountId)) {
        return { allow: false, reason: 'circuit_breaker_tripped' };
      }

      // C2.3 预算 + 动作后冷却
      if (q.enabled) {
        if (!this.checkBudget(input.accountId)) {
          return { allow: false, reason: 'quota_exceeded' };
        }
        const last = this.lastActionAt.get(input.accountId) ?? 0;
        if (Date.now() - last < q.cooldownMsAfterAction) {
          return { allow: false, reason: 'account_cooldown' };
        }
      }

      // C2.4 跨账号去重：相同去重键已被其他账号占用则拦截
      if (d.enabled && input.dedupKey) {
        const seenBy = this.dedupSeen.get(input.dedupKey);
        if (seenBy && seenBy !== input.accountId) {
          log.warn('跨账号去重拦截', { key: input.dedupKey, seenBy, accountId: input.accountId });
          return { allow: false, reason: 'cross_account_dedup' };
        }
      }

      // C2.2 xsecToken 绑定：跨账号复用处理
      if (this.cfg.xsecTokenBinding.enabled && input.xsecToken) {
        const bound = this.tokenBindings.get(input.xsecToken);
        if (bound && bound !== input.accountId) {
          if (this.cfg.xsecTokenBinding.mode === 'block') {
            return { allow: false, reason: 'xsec_token_bound_to_other_account' };
          }
          log.warn('xsecToken 跨账号复用（warn 模式放行）', {
            tokenSuffix: input.xsecToken.slice(0, 6),
            boundTo: bound,
            accountId: input.accountId,
          });
        }
      }

      // —— 原子预占（检查通过即占用，避免并发双计/越限）——
      if (q.enabled) {
        this.recordCount(this.hourly, input.accountId, q.perAccountHourly, 3_600_000);
        this.recordCount(this.daily, input.accountId, q.perAccountDaily, 86_400_000);
        this.lastActionAt.set(input.accountId, Date.now());
      }
      if (d.enabled && input.dedupKey && !this.dedupSeen.has(input.dedupKey)) {
        this.dedupSeen.set(input.dedupKey, input.accountId);
      }
      if (this.cfg.xsecTokenBinding.enabled && input.xsecToken && !this.tokenBindings.has(input.xsecToken)) {
        this.tokenBindings.set(input.xsecToken, input.accountId);
      }

      return { allow: true };
    });
  }

  /**
   * C2.3/C2.4/C2.2 动作后回填与熔断判定。
   * - 业务失败（验证码/风控/429 等，即便 HTTP 成功）也触发熔断（蓝军 #5）；
   * - 执行失败回滚预占的预算计数（冷却锚点保留，避免立即重试尖峰）；
   * - 返回 trippedNow，便于多账号队列立刻取消剩余账号（蓝军 #5）。
   */
  async afterAction(input: AfterActionInput): Promise<{ trippedNow: boolean }> {
    const q = this.cfg.quota;
    if (!q.enabled) return { trippedNow: false };

    // 业务失败判定：执行失败 / 验证码 / 平台风控（即便 HTTP 200）
    const captcha =
      this.isCaptchaLike(input.error) || this.isCaptchaLike(JSON.stringify(input.result ?? ''));
    const businessFailure = !input.success || captcha || this.isBusinessFailure(input.result);

    if (!input.success) {
      // 回滚预占的预算计数（冷却锚点 lastActionAt 保留，避免立即重试制造尖峰）
      this.decrementCount(this.hourly, input.accountId);
      this.decrementCount(this.daily, input.accountId);
    }

    if (businessFailure) {
      const n = (this.consecutiveFailures.get(input.accountId) ?? 0) + 1;
      this.consecutiveFailures.set(input.accountId, n);
      // 硬风控信号（验证码/needVerify/429/403 等，即便 HTTP 成功）立即熔断进入人工；
      // 普通执行失败则按连续阈值累计。
      const hardRisk = captcha || this.isBusinessFailure(input.result);
      if (hardRisk || n >= q.consecutiveFailuresToTrip) {
        this.tripped.add(input.accountId);
        log.warn('账号熔断（进入人工）', { accountId: input.accountId, captcha, hardRisk, consecutive: n });
        return { trippedNow: true };
      }
    } else {
      this.consecutiveFailures.set(input.accountId, 0);
    }

    return { trippedNow: this.tripped.has(input.accountId) };
  }

  /** 查询某账号是否已熔断（测试/运维观测） */
  isTripped(accountId: string): boolean {
    return this.tripped.has(accountId);
  }

  /**
   * C2.2 在 xsecToken「提取」（取笔记详情）时登记其来源账号，
   * 使「谁取到的 token 归谁」，而非「谁先写归谁」（蓝军 #6）。
   * 后续写操作的 beforeAction 会校验来源一致性：跨账号使用 fail-closed 拦截。
   * 首个提取者占用，后续提取同 token 的不同账号不会抢占所有权。
   */
  bindXsecSource(xsecToken: string, accountId: string): void {
    if (!this.cfg.xsecTokenBinding.enabled || !xsecToken) return;
    if (!this.tokenBindings.has(xsecToken)) {
      this.tokenBindings.set(xsecToken, accountId);
    }
  }

  /**
   * 测试/运维用：重置进程内守卫状态。
   */
  reset(): void {
    this.hourly.clear();
    this.daily.clear();
    this.lastActionAt.clear();
    this.tripped.clear();
    this.consecutiveFailures.clear();
    this.dedupSeen.clear();
    this.tokenBindings.clear();
  }

  // ---- 内部 ----

  private checkBudget(accountId: string): boolean {
    const now = Date.now();
    const h = this.hourly.get(accountId);
    if (h && h.resetAt <= now) this.hourly.delete(accountId);
    const d = this.daily.get(accountId);
    if (d && d.resetAt <= now) this.daily.delete(accountId);
    const hc = this.hourly.get(accountId)?.count ?? 0;
    const dc = this.daily.get(accountId)?.count ?? 0;
    return hc < this.cfg.quota.perAccountHourly && dc < this.cfg.quota.perAccountDaily;
  }

  private recordCount(
    map: Map<string, { count: number; resetAt: number }>,
    accountId: string,
    _limit: number,
    windowMs: number,
  ): void {
    const now = Date.now();
    const entry = map.get(accountId);
    if (!entry || entry.resetAt <= now) {
      map.set(accountId, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;
    }
  }

  /** 回滚一次预占计数（执行失败时调用，避免浪费预算） */
  private decrementCount(map: Map<string, { count: number; resetAt: number }>, accountId: string): void {
    const entry = map.get(accountId);
    if (entry) entry.count = Math.max(0, entry.count - 1);
  }

  private isCaptchaLike(text?: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase();
    return this.cfg.quota.captchaErrorPatterns.some((p) => t.includes(p.toLowerCase()));
  }

  /**
   * 平台级业务失败判定（蓝军 #5）：即便 HTTP 执行成功、outcome.success=true，
   * 只要返回体表明验证码/风控/频率限制，也应触发熔断。
   */
  private isBusinessFailure(result: any): boolean {
    if (!result || typeof result !== 'object') return false;
    if (result.needVerify) return true;
    if (typeof result.success === 'boolean' && result.success === false) return true;
    if (typeof result.status === 'number' && (result.status === 429 || result.status === 403)) return true;
    return false;
  }
}

let guardInstance: CooccurrenceGuard | null = null;

/** 获取进程内守卫单例 */
export function getCooccurrenceGuard(): CooccurrenceGuard {
  if (!guardInstance) guardInstance = new CooccurrenceGuard();
  return guardInstance;
}

/**
 * 计算一组媒体文件的 SHA-256（按路径排序后拼接字节），作为跨账号相同媒体的硬去重键。
 * 文件不可读时退化为路径，避免崩溃。
 */
export function sha256OfFiles(files: string[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    try {
      h.update(fs.readFileSync(f));
    } catch {
      h.update(f);
    }
  }
  return h.digest('hex');
}

/** 计算文本的 SHA-256（跨账号相同评论正文去重键） */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
