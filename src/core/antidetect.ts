/**
 * @fileoverview 反检测：多账号共现抑制守卫（波次 C / C2）。
 *
 * 集中实现四个子项，全部通过 config.antiDetect.* 开关独立可回滚：
 * - C2.1 串行 + 账号间随机抖动（消除 ms/秒级同步尖峰）
 * - C2.2 xsecToken 绑定（禁止跨账号复用同一 token，block/warn 两模式）
 * - C2.3 中央限额/熔断（每账号小时/日预算、动作后冷却、连续失败/验证码熔断进入人工）
 * - C2.4 跨账号 content/media 去重（相同评论正文 / 相同媒体哈希硬拦截）
 * - A5 committed 状态 SQLite 持久化（XHS_MCP_AD_PERSIST；token 存哈希）
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
 * A5 持久化后端（由 AntidetectPersistRepository 实现）。
 * Guard 不直接依赖 better-sqlite3，便于单测注入内存假实现。
 */
export interface AdPersistStore {
  upsertDedup(dedupKey: string, accountId: string, createdAt: number, expiresAt: number): void;
  upsertToken(tokenHash: string, accountId: string, createdAt: number, expiresAt: number): void;
  loadActiveDedups(nowMs: number): Array<{
    dedup_key: string;
    account_id: string;
    created_at: number;
    expires_at: number;
  }>;
  loadActiveTokens(nowMs: number): Array<{
    token_hash: string;
    account_id: string;
    created_at: number;
    expires_at: number;
  }>;
  deleteExpired(nowMs: number): number;
  clearAll(): void;
}

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
  private dedupInFlight = new Map<string, Set<string>>(); // 去重键 -> 占用该键的 reservationId 集合（引用计数，R4 同账号并发复用）
  private dedupOwner = new Map<string, string>(); // 去重键 -> 账号 ID（in-flight 或 committed 均记录）
  private dedupSucceeded = new Set<string>(); // 去重键 -> 任一并发占用成功（用于最后一次完成时判定提交/回滚）
  // xsecToken 绑定：提取点登记为永久来源（committed）；写路径临时占用带 reservationId
  private tokenCommitted = new Set<string>();
  private tokenInFlight = new Map<string, Set<string>>(); // token -> reservationId 集合
  private tokenOwner = new Map<string, string>(); // token -> 账号 ID
  private tokenSucceeded = new Set<string>();
  /** A5：committed 过期时间（ms）；未设置表示不过期（persist 关闭时） */
  private dedupExpires = new Map<string, number>();
  private tokenExpires = new Map<string, number>();
  /** 蓝军 #4：检查/预占的全局 policy 互斥锁 */
  private policyMutex = new AsyncMutex();
  /** A5：可选持久化后端；未挂载或 persist.enabled=false 时仅内存 */
  private persistStore: AdPersistStore | null = null;

  constructor(private cfg = config.antiDetect) {}

  /** A5：是否启用 committed 落库 */
  private isPersistEnabled(): boolean {
    return !!this.cfg.persist?.enabled && !!this.persistStore;
  }

  /** xsecToken 统一用 SHA-256 作为内存/库键，避免明文落库与重启不一致 */
  private tokenKey(token: string): string {
    return sha256OfText(token);
  }

  private expiresAtFromNow(now = Date.now()): number {
    // 非法/过小 TTL 至少 1ms，避免永久卡死或负过期
    const ttl = Math.max(1, this.cfg.persist?.ttlMs ?? 30 * 24 * 60 * 60 * 1000);
    return now + ttl;
  }

  /** 惰性过期：若 committed 已过 TTL，从内存剔除并触发库 GC */
  private purgeExpiredDedup(key: string, now = Date.now()): void {
    const exp = this.dedupExpires.get(key);
    if (exp === undefined || exp > now) return;
    this.dedupCommitted.delete(key);
    this.dedupExpires.delete(key);
    if (!this.dedupInFlight.has(key)) this.dedupOwner.delete(key);
    this.persistStore?.deleteExpired(now);
  }

  private purgeExpiredTokenHash(tKey: string, now = Date.now()): void {
    const exp = this.tokenExpires.get(tKey);
    if (exp === undefined || exp > now) return;
    this.tokenCommitted.delete(tKey);
    this.tokenExpires.delete(tKey);
    if (!this.tokenInFlight.has(tKey)) this.tokenOwner.delete(tKey);
    this.persistStore?.deleteExpired(now);
  }

  /**
   * A5：挂载持久化后端并加载未过期 committed 行（启动时由 initDatabase 调用）。
   * 可重复调用；会先 GC 过期行再灌入内存（不清空已有 in-flight）。
   */
  attachPersistence(store: AdPersistStore): void {
    this.persistStore = store;
    if (!this.cfg.persist?.enabled) {
      log.info('A5 守卫持久化已挂载但 config.persist.enabled=false，跳过加载');
      return;
    }
    this.loadPersistent();
  }

  /** A5：从 store 刷新 committed（覆盖内存中的 committed，保留 in-flight） */
  loadPersistent(): void {
    if (!this.persistStore || !this.cfg.persist?.enabled) return;
    const now = Date.now();
    const purged = this.persistStore.deleteExpired(now);
    if (purged > 0) {
      log.info('A5 GC 过期守卫行', { purged });
    }

    // 先清掉已提交态，再灌库，避免库已删除的行继续挡（P3 merge 残留）
    for (const key of [...this.dedupCommitted]) {
      this.dedupCommitted.delete(key);
      this.dedupExpires.delete(key);
      if (!this.dedupInFlight.has(key)) this.dedupOwner.delete(key);
    }
    for (const tKey of [...this.tokenCommitted]) {
      this.tokenCommitted.delete(tKey);
      this.tokenExpires.delete(tKey);
      if (!this.tokenInFlight.has(tKey)) this.tokenOwner.delete(tKey);
    }

    for (const row of this.persistStore.loadActiveDedups(now)) {
      this.dedupCommitted.add(row.dedup_key);
      this.dedupOwner.set(row.dedup_key, row.account_id);
      this.dedupExpires.set(row.dedup_key, row.expires_at);
    }
    for (const row of this.persistStore.loadActiveTokens(now)) {
      this.tokenCommitted.add(row.token_hash);
      this.tokenOwner.set(row.token_hash, row.account_id);
      this.tokenExpires.set(row.token_hash, row.expires_at);
    }
    log.info('A5 已加载守卫持久化状态', {
      dedup: this.dedupCommitted.size,
      tokens: this.tokenCommitted.size,
    });
  }

  private persistDedup(key: string, accountId: string): void {
    if (!this.isPersistEnabled() || !this.persistStore) return;
    const now = Date.now();
    const exp = this.expiresAtFromNow(now);
    this.persistStore.deleteExpired(now);
    this.persistStore.upsertDedup(key, accountId, now, exp);
    this.dedupExpires.set(key, exp);
  }

  private persistTokenHash(tokenHash: string, accountId: string): void {
    if (!this.isPersistEnabled() || !this.persistStore) return;
    const now = Date.now();
    const exp = this.expiresAtFromNow(now);
    this.persistStore.deleteExpired(now);
    this.persistStore.upsertToken(tokenHash, accountId, now, exp);
    this.tokenExpires.set(tokenHash, exp);
  }

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
        this.purgeExpiredDedup(input.dedupKey);
        if (this.dedupCommitted.has(input.dedupKey)) {
          const owner = this.dedupOwner.get(input.dedupKey);
          if (owner && owner !== input.accountId) {
            log.warn('跨账号去重拦截', { key: input.dedupKey, owner, accountId: input.accountId });
            return { allow: false, reason: 'cross_account_dedup' };
          }
          // 同账号已提交：放行（去重仅跨账号），不预占
        } else if (this.dedupInFlight.has(input.dedupKey)) {
          const owner = this.dedupOwner.get(input.dedupKey);
          if (owner && owner !== input.accountId) {
            log.warn('跨账号去重拦截', { key: input.dedupKey, owner, accountId: input.accountId });
            return { allow: false, reason: 'cross_account_dedup' };
          }
          // 同账号进行中（并发复用）：加入共享 in-flight 占用集合（引用计数，R4），不单独放行也不同步
        }
      }

      // C2.2 xsecToken 绑定：跨账号复用处理（内存键为 token 哈希，A5）
      if (this.cfg.xsecTokenBinding.enabled && input.xsecToken) {
        this.purgeExpiredTokenHash(this.tokenKey(input.xsecToken));
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
      if (d.enabled && input.dedupKey && !this.dedupCommitted.has(input.dedupKey)) {
        let set = this.dedupInFlight.get(input.dedupKey);
        if (!set) {
          set = new Set<string>();
          this.dedupInFlight.set(input.dedupKey, set);
          this.dedupOwner.set(input.dedupKey, input.accountId);
        }
        // 同账号并发复用：把本次 reservationId 加入共享占用集合（引用计数，R4）
        set.add(resvId);
        reservedDedup = input.dedupKey;
      }
      if (this.cfg.xsecTokenBinding.enabled && input.xsecToken) {
        const tKey = this.tokenKey(input.xsecToken);
        if (!this.tokenCommitted.has(tKey)) {
          const owner = this.tokenOwnerOf(input.xsecToken);
          // 未绑定 token 由本账号首次占用；同账号并发复用加入同一 reservation 集合。
          // warn 模式下跨账号只放行业务，不加入原 owner 的集合，避免篡改来源归属。
          if (!owner || owner === input.accountId) {
            let set = this.tokenInFlight.get(tKey);
            if (!set) {
              set = new Set<string>();
              this.tokenInFlight.set(tKey, set);
              this.tokenOwner.set(tKey, input.accountId);
            }
            set.add(resvId);
            reservedToken = input.xsecToken; // reservation 仍带明文，settle 时再 hash
          }
        }
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
    // R3-4/R4：先统一计算执行结果语义，供提交/预算/熔断共用。
    // - executionSuccess：操作 Promise 正常返回（input.success）；
    // - businessFail：平台返回体显式 success:false 即视为业务失败（执行器不抛异常）；
    // - hardRisk：验证码/needVerify/明确 403/429 —— 立即熔断；
    // - businessSuccess：执行成功 && 非业务失败 && 非硬风控，才提交去重/token 占用并保留预算。
    // R4 修正：{success:true, result:{success:false}} 这类软业务失败必须视为「未成功」，
    // 既不可提交去重占用（否则死占 key），也须回滚预算（否则 B 用同 key 得 cross_account_dedup）。
    const hardRisk =
      this.isCaptchaLike(input.error) ||
      this.isCaptchaLike(JSON.stringify(input.result ?? '')) ||
      this.isBusinessFailure(input.result);
    const businessFail =
      !input.success ||
      (input.result !== null && typeof input.result === 'object' && (input.result as any).success === false);
    const businessSuccess = input.success && !businessFail && !hardRisk;

    // R3-2/R4：按 reservationId 提交/回滚去重与 token 的临时占用（引用计数）。
    // 成功提交：所有并发占用中「任一成功」即转为永久占用（committed）；全部失败才回收占用。
    // compare-and-delete 仅删除本次 reservationId，绝不误删他人/已提交占用
    //（修复 R4 P1 1019970087：同账号并发一次成功一次失败时，第二次成功提交不被第一次失败弄丢）。
    if (input.reservation?.id) {
      const id = input.reservation.id;
      if (input.reservation.dedupKey) {
        this.settleDedupReservation(input.reservation.dedupKey, id, businessSuccess);
      }
      if (input.reservation.xsecToken) {
        this.settleTokenReservation(input.reservation.xsecToken, id, businessSuccess);
      }
    }

    // R3-3：dedup/token 的预占提交/回滚独立于 quota.enabled（dedup/xsec 是可独立开关的子项）。
    // 即便 quota 关闭，上面的占用提交/回滚仍执行；仅预算计数与熔断逻辑受 quota.enabled 约束。
    const q = this.cfg.quota;
    if (!q.enabled) return { trippedNow: false };

    // 预算计数回滚（仅业务未成功；冷却锚点 lastActionAt 保留，避免立即重试制造尖峰）。
    // R4：软业务失败（success:true, result.success:false）与硬风控同样非 businessSuccess，须回滚预算。
    if (!businessSuccess) {
      this.decrementCount(this.hourly, input.accountId);
      this.decrementCount(this.daily, input.accountId);
    }

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

  /**
   * R4（P1 1019834745）：在取得 policy reservation 后、真正 DOM 写前若设备不在场，
   * 回滚该 reservation 的临时占用（去重/token）而不计入业务失败/熔断。
   * 与 afterAction 的区别：仅 compare-and-delete 本次 reservationId，不影响连续失败计数；
   * beforeAction 已预扣的小时/日预算仍须退回，冷却锚点保留。
   */
  async cancelReservation(reservation: PolicyReservation | undefined, accountId: string): Promise<void> {
    if (!reservation?.id) return;
    const id = reservation.id;
    if (reservation.dedupKey) {
      this.settleDedupReservation(reservation.dedupKey, id, false);
    }
    if (reservation.xsecToken) {
      this.settleTokenReservation(reservation.xsecToken, id, false);
    }

    if (this.cfg.quota.enabled) {
      this.decrementCount(this.hourly, accountId);
      this.decrementCount(this.daily, accountId);
    }
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
    const tKey = this.tokenKey(xsecToken);
    if (!this.tokenCommitted.has(tKey)) {
      this.tokenCommitted.add(tKey);
      this.tokenOwner.set(tKey, accountId);
      this.persistTokenHash(tKey, accountId);
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
    this.purgeExpiredTokenHash(this.tokenKey(xsecToken));
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

  /** 查询 token 当前所有者（committed 或 in-flight 占用均计入；键为哈希） */
  private tokenOwnerOf(token: string): string | undefined {
    const tKey = this.tokenKey(token);
    this.purgeExpiredTokenHash(tKey);
    return this.tokenOwner.get(tKey);
  }

  /** 清空进程内全部守卫状态（含 expires） */
  private clearMemoryState(): void {
    this.hourly.clear();
    this.daily.clear();
    this.lastActionAt.clear();
    this.tripped.clear();
    this.consecutiveFailures.clear();
    this.dedupCommitted.clear();
    this.dedupInFlight.clear();
    this.dedupOwner.clear();
    this.dedupSucceeded.clear();
    this.dedupExpires.clear();
    this.tokenCommitted.clear();
    this.tokenInFlight.clear();
    this.tokenOwner.clear();
    this.tokenSucceeded.clear();
    this.tokenExpires.clear();
  }

  /**
   * 测试/运维用：重置进程内守卫状态。
   * A5：若持久化开启，清空内存后从库重新加载 committed，避免出现「库有记录但不拦截」的空洞。
   */
  reset(): void {
    this.clearMemoryState();
    if (this.isPersistEnabled()) {
      this.loadPersistent();
    }
  }

  /**
   * A5 测辅：清空持久化表 + 内存状态（含 in-flight）。
   * 未挂载 store 时等价于仅清内存。
   */
  clearPersistent(): void {
    this.persistStore?.clearAll();
    this.clearMemoryState();
  }

  // ---- 内部 ----

  /**
   * 完成一次 dedup reservation。任一并发调用成功时，最后一个引用离开后提交；
   * 全部失败或取消时才释放 owner。afterAction 与 cancelReservation 共用，避免分支语义漂移。
   */
  private settleDedupReservation(key: string, id: string, succeeded: boolean): void {
    const set = this.dedupInFlight.get(key);
    if (!set || !set.delete(id)) return;
    if (succeeded) this.dedupSucceeded.add(key);
    if (set.size > 0) return;

    this.dedupInFlight.delete(key);
    if (this.dedupSucceeded.has(key)) {
      this.dedupCommitted.add(key);
      const owner = this.dedupOwner.get(key);
      if (owner) this.persistDedup(key, owner);
    } else {
      this.dedupOwner.delete(key);
    }
    this.dedupSucceeded.delete(key);
  }

  /** xsecToken reservation 的收敛逻辑；内存键为 token 哈希（A5）。 */
  private settleTokenReservation(token: string, id: string, succeeded: boolean): void {
    const tKey = this.tokenKey(token);
    const set = this.tokenInFlight.get(tKey);
    if (!set || !set.delete(id)) return;
    if (succeeded) this.tokenSucceeded.add(tKey);
    if (set.size > 0) return;

    this.tokenInFlight.delete(tKey);
    if (this.tokenSucceeded.has(tKey)) {
      this.tokenCommitted.add(tKey);
      const owner = this.tokenOwner.get(tKey);
      if (owner) this.persistTokenHash(tKey, owner);
    } else {
      this.tokenOwner.delete(tKey);
    }
    this.tokenSucceeded.delete(tKey);
  }

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
