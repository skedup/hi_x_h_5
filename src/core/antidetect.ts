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

import { createHash, randomUUID } from 'node:crypto';
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
 * beforeAction 新占用的资源（仅记录本次调用「新写入」的条目，用于失败/取消时精确回滚）。
 * 已存在（非本次占用）的条目不在此列，回滚时不会误删他人/既有的绑定（R2-9）。
 * id 为该次占用的唯一 reservationId，回滚/提交均按 id 做 compare-and-delete（R3-2）。
 */
export interface PolicyReservation {
  /** 本次新占用的跨账号去重键 */
  dedupKey?: string;
  /** 本次新绑定的 xsecToken */
  xsecToken?: string;
  /** 本次占用的唯一 id（R3-2：分层临时占用/提交，按 id 提交或回滚） */
  id?: string;
}

/**
 * 动作前核查返回：allow=false 携带 skip 原因；reservation 为本次新占用的资源（R2-9）。
 */
export interface BeforeActionResult {
  allow: boolean;
  reason?: string;
  reservation?: PolicyReservation;
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
  /** beforeAction 返回的本次新占用资源；失败/取消时精确回滚（R2-9） */
  reservation?: PolicyReservation;
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
  // 去重：已提交（永久占用，成功落库）/ 进行中（临时占用，带 reservationId）/ 所有者
  private dedupCommitted = new Set<string>();
  private dedupInFlight = new Map<string, string>(); // 去重键 -> reservationId
  private dedupOwner = new Map<string, string>(); // 去重键 -> 账号 ID
  // xsecToken 绑定：提取点登记为永久来源（committed）；写路径临时占用带 reservationId
  private tokenCommitted = new Set<string>();
  private tokenInFlight = new Map<string, string>(); // token -> reservationId
  private tokenOwner = new Map<string, string>(); // token -> 账号 ID
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
  async beforeAction(input: BeforeActionInput): Promise<BeforeActionResult> {
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

      const resvId = randomUUID();

      // C2.4 跨账号去重：相同去重键已被占用（已提交或他人进行中）则拦截
      if (d.enabled && input.dedupKey) {
        if (this.dedupCommitted.has(input.dedupKey) || this.dedupInFlight.has(input.dedupKey)) {
          const owner = this.dedupOwner.get(input.dedupKey);
          if (owner && owner !== input.accountId) {
            log.warn('跨账号去重拦截', { key: input.dedupKey, owner, accountId: input.accountId });
            return { allow: false, reason: 'cross_account_dedup' };
          }
          // 同账号进行中（并发复用）放行，待成功提交时落库；其余情况放行预占
        }
      }

      // C2.2 xsecToken 绑定：跨账号复用处理
      if (this.cfg.xsecTokenBinding.enabled && input.xsecToken) {
        const owner = this.tokenOwnerOf(input.xsecToken);
        if (owner && owner !== input.accountId) {
          if (this.cfg.xsecTokenBinding.mode === 'block') {
            return { allow: false, reason: 'xsec_token_bound_to_other_account' };
          }
          log.warn('xsecToken 跨账号复用（warn 模式放行）', {
            tokenSuffix: input.xsecToken.slice(0, 6),
            boundTo: owner,
            accountId: input.accountId,
          });
        }
      }

      // —— 原子预占（检查通过即占用，避免并发双计/越限）——
      // R2-9 / R3-2：仅记录「本次新占用」的资源（带 reservationId），供失败/取消时精确回滚；
      // 成功时按 id 提交为永久占用，不回滚既有/他人绑定。
      let reservedDedup: string | undefined;
      let reservedToken: string | undefined;
      if (q.enabled) {
        this.recordCount(this.hourly, input.accountId, q.perAccountHourly, 3_600_000);
        this.recordCount(this.daily, input.accountId, q.perAccountDaily, 86_400_000);
        this.lastActionAt.set(input.accountId, Date.now());
      }
      if (d.enabled && input.dedupKey && !this.dedupCommitted.has(input.dedupKey) && !this.dedupInFlight.has(input.dedupKey)) {
        this.dedupInFlight.set(input.dedupKey, resvId);
        this.dedupOwner.set(input.dedupKey, input.accountId);
        reservedDedup = input.dedupKey;
      }
      if (this.cfg.xsecTokenBinding.enabled && input.xsecToken && !this.tokenOwnerOf(input.xsecToken)) {
        this.tokenInFlight.set(input.xsecToken, resvId);
        this.tokenOwner.set(input.xsecToken, input.accountId);
        reservedToken = input.xsecToken;
      }

      return { allow: true, reservation: { dedupKey: reservedDedup, xsecToken: reservedToken, id: resvId } };
    });
  }

  /**
   * C2.3/C2.4/C2.2 动作后回填与熔断判定。
   * - 业务失败（验证码/风控/429 等，即便 HTTP 成功）也触发熔断（蓝军 #5）；
   * - 执行失败回滚预占的预算计数（冷却锚点保留，避免立即重试尖峰）；
   * - 返回 trippedNow，便于多账号队列立刻取消剩余账号（蓝军 #5）。
   */
  async afterAction(input: AfterActionInput): Promise<{ trippedNow: boolean }> {
    // R3-2：按 reservationId 提交/回滚去重与 token 的临时占用。
    // 成功提交：本次（或并发同账号复用）占用转为永久占用（committed），后续同 key/token 被去重/拦截。
    // 失败回滚：仅当临时占用仍归属于本次 reservationId 时才删除（compare-and-delete），
    // 绝不误删他人/已提交占用（避免 A 失败把 A2 的成功提交弄丢）。
    if (input.reservation?.id) {
      const id = input.reservation.id;
      if (input.reservation.dedupKey) {
        if (input.success) {
          if (this.dedupInFlight.has(input.reservation.dedupKey)) {
            this.dedupInFlight.delete(input.reservation.dedupKey);
            // 保留 dedupOwner：committed 占用仍需保留所有者，供跨账号去重校验（R2-9/R3-2）
            this.dedupCommitted.add(input.reservation.dedupKey);
          }
        } else if (this.dedupInFlight.get(input.reservation.dedupKey) === id) {
          this.dedupInFlight.delete(input.reservation.dedupKey);
          this.dedupOwner.delete(input.reservation.dedupKey);
        }
      }
      if (input.reservation.xsecToken) {
        if (input.success) {
          if (this.tokenInFlight.has(input.reservation.xsecToken)) {
            this.tokenInFlight.delete(input.reservation.xsecToken);
            this.tokenCommitted.add(input.reservation.xsecToken);
          }
        } else if (this.tokenInFlight.get(input.reservation.xsecToken) === id) {
          this.tokenInFlight.delete(input.reservation.xsecToken);
          this.tokenOwner.delete(input.reservation.xsecToken);
        }
      }
    }

    // R3-3：dedup/token 的预占提交/回滚独立于 quota.enabled（dedup/xsec 是可独立开关的子项）。
    // 即便 quota 关闭，上面的占用提交/回滚仍执行；仅预算计数与熔断逻辑受 quota.enabled 约束。
    const q = this.cfg.quota;
    if (!q.enabled) return { trippedNow: false };

    // 预算计数回滚（仅执行失败；冷却锚点 lastActionAt 保留，避免立即重试制造尖峰）
    if (!input.success) {
      this.decrementCount(this.hourly, input.accountId);
      this.decrementCount(this.daily, input.accountId);
    }

    // R3-4：拆分 executionSuccess / businessSuccess / hardRisk。
    // - executionSuccess：操作 Promise 正常返回（input.success）；
    // - businessSuccess：平台返回体显式 success:false 即视为业务失败（执行器不抛异常，故需单独看 result）；
    // - hardRisk：验证码/needVerify/明确 403/429 —— 立即熔断。
    // 普通业务失败累计连续阈值并回滚未提交预占（上面已回滚），只有硬风控立即熔断。
    const hardRisk =
      this.isCaptchaLike(input.error) ||
      this.isCaptchaLike(JSON.stringify(input.result ?? '')) ||
      this.isBusinessFailure(input.result);
    const businessFail =
      !input.success ||
      (input.result !== null && typeof input.result === 'object' && (input.result as any).success === false);

    // 进入计数/熔断分支的条件：软业务失败，或硬风控信号（即便 HTTP 成功也需立即熔断——蓝军 #5）。
    // 注意：hardRisk 必须能独立进入本分支，否则 {needVerify:true} 这类 HTTP 成功但业务风控的信号不会熔断。
    if (hardRisk || businessFail) {
      const n = (this.consecutiveFailures.get(input.accountId) ?? 0) + 1;
      this.consecutiveFailures.set(input.accountId, n);
      if (hardRisk || n >= q.consecutiveFailuresToTrip) {
        this.tripped.add(input.accountId);
        log.warn('账号熔断（进入人工）', { accountId: input.accountId, hardRisk, consecutive: n });
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
   * C2.2 在 xsecToken「提取」（取笔记详情 / search / list_feeds / explore feed）时登记其来源账号，
   * 使「谁取到的 token 归谁」，而非「谁先写归谁」（蓝军 #6）。提取点绑定为永久来源（committed），
   * 后续写操作的 checkXsecSource 只校验既有来源；消费路径（get_note/download/user_profile）
   * 不得补写来源（R3-5）。首个提取者占用，后续提取同 token 的不同账号不会抢占所有权。
   */
  bindXsecSource(xsecToken: string, accountId: string): void {
    if (!this.cfg.xsecTokenBinding.enabled || !xsecToken) return;
    if (!this.tokenCommitted.has(xsecToken)) {
      this.tokenCommitted.add(xsecToken);
      this.tokenOwner.set(xsecToken, accountId);
    }
  }

  /**
   * R3-5：消费路径（get_note/download/user_profile）校验既有 xsecToken 来源。
   * - block 模式：未知来源（消费路径不得补写）或跨账号复用一律拒绝；
   * - warn 模式：放行但记录。
   */
  checkXsecSource(
    xsecToken: string,
    accountId: string,
  ): { known: boolean; allow: boolean; reason?: string } {
    if (!this.cfg.xsecTokenBinding.enabled || !xsecToken) return { known: false, allow: true };
    const owner = this.tokenOwnerOf(xsecToken);
    if (!owner) {
      if (this.cfg.xsecTokenBinding.mode === 'block') {
        return { known: false, allow: false, reason: 'xsec_token_unknown_source' };
      }
      return { known: false, allow: true };
    }
    if (owner !== accountId) {
      if (this.cfg.xsecTokenBinding.mode === 'block') {
        return { known: true, allow: false, reason: 'xsec_token_bound_to_other_account' };
      }
      return { known: true, allow: true };
    }
    return { known: true, allow: true };
  }

  /** 查询 token 当前所有者（committed 或 in-flight 占用均计入） */
  private tokenOwnerOf(token: string): string | undefined {
    return this.tokenOwner.get(token);
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
    this.dedupCommitted.clear();
    this.dedupInFlight.clear();
    this.dedupOwner.clear();
    this.tokenCommitted.clear();
    this.tokenInFlight.clear();
    this.tokenOwner.clear();
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
   * 平台级硬风控判定（蓝军 #5 / R2-10）：仅当返回体明确表明验证码/风控/频率限制时才算「硬风险」，
   * 触发即时熔断。普通的「业务失败」（如 success:false 但无风控信号）不再算硬风险，
   * 改为按连续失败阈值累计（见 afterAction 的 consecutiveFailuresToTrip），避免首次即熔断。
   */
  private isBusinessFailure(result: any): boolean {
    if (!result || typeof result !== 'object') return false;
    if (result.needVerify) return true;
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
