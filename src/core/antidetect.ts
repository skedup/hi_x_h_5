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
   * C2.1/C2.2/C2.3/C2.4 动作前核查。
   * @returns allow=false 时携带 reason（skip 原因），调用方应跳过该账号动作。
   */
  beforeAction(input: BeforeActionInput): { allow: boolean; reason?: string } {
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

    return { allow: true };
  }

  /**
   * C2.3/C2.4/C2.2 动作后回填：记录预算、判定熔断、登记去重/绑定。
   */
  afterAction(input: AfterActionInput): void {
    const q = this.cfg.quota;

    if (q.enabled) {
      const now = Date.now();
      this.recordCount(this.hourly, input.accountId, q.perAccountHourly, 3_600_000);
      this.recordCount(this.daily, input.accountId, q.perAccountDaily, 86_400_000);
      this.lastActionAt.set(input.accountId, now);

      if (!input.success) {
        const n = (this.consecutiveFailures.get(input.accountId) ?? 0) + 1;
        this.consecutiveFailures.set(input.accountId, n);
        const captcha = this.isCaptchaLike(input.error) || this.isCaptchaLike(JSON.stringify(input.result ?? ''));
        if (captcha || n >= q.consecutiveFailuresToTrip) {
          this.tripped.add(input.accountId);
          log.warn('账号熔断（进入人工）', { accountId: input.accountId, captcha, consecutive: n });
        }
      } else {
        this.consecutiveFailures.set(input.accountId, 0);
      }
    }

    // C2.4 仅成功写操作登记去重（避免失败也污染）
    if (this.cfg.dedup.enabled && input.success && input.dedupKey) {
      this.dedupSeen.set(input.dedupKey, input.accountId);
    }

    // C2.2 仅成功动作登记 token 绑定（首次占用者）
    if (this.cfg.xsecTokenBinding.enabled && input.xsecToken && input.success) {
      if (!this.tokenBindings.has(input.xsecToken)) {
        this.tokenBindings.set(input.xsecToken, input.accountId);
      }
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

  private isCaptchaLike(text?: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase();
    return this.cfg.quota.captchaErrorPatterns.some((p) => t.includes(p.toLowerCase()));
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
