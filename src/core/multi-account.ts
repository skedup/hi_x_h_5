/**
 * @fileoverview 多账户操作执行辅助工具。
 * 提供在单个或多个账户上运行操作的实用函数，
 * 包含自动锁定、日志记录和错误处理。
 * @module core/multi-account
 */

import { AccountPool } from './account-pool.js';
import { XhsDatabase } from '../db/index.js';
import { XhsClient } from '../xhs/index.js';
import { createLogger } from './logger.js';
import { sleep } from '../xhs/utils/index.js';
import { getCooccurrenceGuard } from './antidetect.js';
import { isWriteAllowed } from './liveness.js';
import { config } from './config.js';
import { evaluateMultiAccountProxyGate } from './proxy.js';
import type { ToolCapability } from './audit.js';

const log = createLogger('multi-account');

/**
 * 指定使用哪个账户执行操作的参数
 */
export interface MultiAccountParams {
  /** 单个账户名称或 ID */
  account?: string;
  /** 多个账户：名称/ID 数组，或 'all' 表示所有活跃账户 */
  accounts?: string[] | 'all';
}

/**
 * 提供给操作回调的上下文
 * 包含解析后的账户信息和客户端实例
 */
export interface OperationContext {
  /** 账户 ID */
  accountId: string;
  /** 账户名称 */
  accountName: string;
  /** 用于执行操作的 XhsClient 实例 */
  client: XhsClient;
}

/**
 * 单个账户操作的结果
 * @template T - 操作结果的类型
 */
export interface OperationResult<T> {
  /** 执行操作的账户名称 */
  account: string;
  /** 操作是否成功 */
  success: boolean;
  /** 操作结果（成功时） */
  result?: T;
  /** 错误信息（失败时） */
  error?: string;
  /** 操作耗时（毫秒） */
  durationMs?: number;
  /** 被共现守卫跳过（预算/冷却/熔断/去重/xsec 绑定）时为 true */
  skipped?: boolean;
  /** 本账号动作后触发熔断（蓝军 #5，供多账号队列即时取消剩余账号） */
  trippedNow?: boolean;
}

/**
 * 在单个账户上执行操作
 *
 * 自动处理锁定、错误处理和操作日志记录。
 *
 * @template T - 操作结果的类型
 * @param pool - 账户池实例
 * @param db - 数据库实例
 * @param accountIdOrName - 要使用的账户（ID 或名称）
 * @param action - 操作名称（用于日志）
 * @param operation - 要执行的异步函数
 * @param options - 可选的日志和锁定参数
 * @returns 包含成功状态和耗时的操作结果
 */
export async function executeWithAccount<T>(
  pool: AccountPool,
  db: XhsDatabase,
  accountIdOrName: string,
  action: string,
  operation: (ctx: OperationContext) => Promise<T>,
  options?: {
    logParams?: any;
    lockTimeout?: number;
    /** C2.4 跨账号去重键（相同键被其他账号占用则跳过本账号动作） */
    dedupKey?: string;
    /** C2.2 本账号意图使用的 xsecToken（用于跨账号复用检测） */
    xsecToken?: string;
    /**
     * 动作能力分级（蓝军 #3）：
     * - 'write'   默认；受全部反检测门禁（账号状态/息屏/headless/预算熔断去重）约束；
     * - 'read'    只读：不受息屏/headless/预算熔断门禁（不伪造人工活动）；
     * - 'control' 本机控制（如停止浏览）：无条件放行，永远可用于脱离自动化。
     */
    capability?: ToolCapability;
  },
): Promise<OperationResult<T>> {
  const account = pool.getAccount(accountIdOrName);
  if (!account) {
    return {
      account: accountIdOrName,
      success: false,
      error: `Account not found: ${accountIdOrName}`,
    };
  }

  // 蓝军 #1 + R2-6：migration_required 账号必须重登录绑定独立 profile 后方可触网。
  // 任何「触碰浏览器」的操作（含 read/control）一律拒绝，避免 account-pool 以 profileId=null
  // 回退共享 profile 目录而破坏账号隔离。仅本地管理/重登录（xhs_add_account）不经此汇聚点。
  if (account.status === 'migration_required') {
    return {
      account: account.name,
      success: false,
      skipped: true,
      error: `account_inactive:migration_required`,
      durationMs: 0,
    };
  }

  // 蓝军 #3：能力分级。read/control 不受账号状态/息屏/headless 反检测门禁约束；
  // 仅 write 受全部门禁约束。默认按 write 处理（fail-safe）。
  const cap: ToolCapability = options?.capability ?? 'write';

  // 蓝军 #1：非 active 账号（suspended / banned）拒绝写操作；
  // 恢复路径 xhs_add_account 不经此汇聚点。read/control（如停止浏览）即便账号非 active 也应放行。
  if (cap === 'write' && account.status !== 'active') {
    return {
      account: account.name,
      success: false,
      skipped: true,
      error: `account_inactive:${account.status ?? 'unknown'}`,
      durationMs: 0,
    };
  }

  // C3.2 息屏/无人值守自保：仅 write 需设备在场，否则停写（read/control 不受限）
  if (cap === 'write') {
    const live = isWriteAllowed();
    if (!live.allowed) {
      return {
        account: account?.name ?? accountIdOrName,
        success: false,
        skipped: true,
        error: `liveness_paused:${live.reason ?? 'unknown'}`,
        durationMs: 0,
      };
    }

    // B1 headless 门禁：仅 write 拒绝 headless（强制 headful 以保留设备在场语义）
    if (config.antiDetect.headlessWriteGate.enabled && config.browser.headless) {
      return {
        account: account?.name ?? accountIdOrName,
        success: false,
        skipped: true,
        error: 'headless_write_blocked',
        durationMs: 0,
      };
    }
  }

  // C2.1/C2.2/C2.3/C2.4 动作前核查（原子检查+预占）：仅 write 调用
  const guard = getCooccurrenceGuard();
  let before: Awaited<ReturnType<typeof guard.beforeAction>> | null = null;
  if (cap === 'write') {
    before = await guard.beforeAction({
      accountId: account.id,
      action,
      dedupKey: options?.dedupKey,
      xsecToken: options?.xsecToken,
    });
    if (!before.allow) {
      return {
        account: account.name,
        success: false,
        skipped: true,
        error: before.reason,
        durationMs: 0,
      };
    }
  }

  const startTime = Date.now();
  let release: (() => void) | null = null;
  let outcome: { success: boolean; error?: string; result?: T };

  try {
    // Acquire lock（R2-4：control 本机控制操作——如停止浏览——不取业务锁，
    // 以免被正在进行的长任务写锁阻塞，保证可随时打断/脱离自动化）
    if (cap !== 'control') {
      release = await pool.acquireLock(account.id, action, options?.lockTimeout);
    }

    // Get client
    const client = await pool.getClient(account.id);
    if (!client) {
      throw new Error('Failed to get client for account');
    }

    // Execute operation
    const result = await operation({
      accountId: account.id,
      accountName: account.name,
      client,
    });

    outcome = { success: true, result };
  } catch (error) {
    outcome = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (release) {
      release();
    }
  }

  const durationMs = Date.now() - startTime;

  // C2.3/C2.4/C2.2 动作后回填：预算/熔断/去重/token 绑定（仅 write 调用守卫）
  let trippedNow = false;
  if (cap === 'write') {
    const after = await guard.afterAction({
      accountId: account.id,
      action,
      success: outcome.success,
      error: outcome.error,
      result: outcome.result,
      dedupKey: options?.dedupKey,
      xsecToken: options?.xsecToken,
      reservation: before?.reservation,
    });
    trippedNow = after.trippedNow;
  }

  if (outcome.success) {
    // Log success
    db.operations.log({
      accountId: account.id,
      action,
      params: options?.logParams,
      result: outcome.result as any,
      success: true,
      durationMs,
    });
    // Touch account
    pool.touchAccount(account.id);
    return {
      account: account.name,
      success: true,
      result: outcome.result,
      durationMs,
      trippedNow,
    };
  }

  // Log failure
  db.operations.log({
    accountId: account.id,
    action,
    params: options?.logParams,
    success: false,
    error: outcome.error,
    durationMs,
  });
  return {
    account: account.name,
    success: false,
    error: outcome.error,
    durationMs,
    trippedNow,
  };
}

/**
 * 在多个账户上执行操作
 *
 * 支持单个账户、多个账户或所有活跃账户。
 * 处理账户解析、并行/串行执行和聚合结果。
 *
 * 执行策略：
 * - 默认并行执行：同时在所有账户上执行操作，提高效率
 * - 可选串行执行：按顺序执行，适用于需要控制执行顺序的场景
 *
 * @template T - 操作结果的类型
 * @param pool - 账户池实例
 * @param db - 数据库实例
 * @param params - 账户选择参数
 * @param action - 操作名称（用于日志）
 * @param operation - 在每个账户上执行的异步函数
 * @param options - 可选参数，包括串行执行模式
 * @returns 所有账户的操作结果数组
 */
export async function executeWithMultipleAccounts<T>(
  pool: AccountPool,
  db: XhsDatabase,
  params: MultiAccountParams,
  action: string,
  operation: (ctx: OperationContext) => Promise<T>,
  options?: {
    logParams?: any;
    lockTimeout?: number;
    sequential?: boolean; // Run operations sequentially instead of in parallel
    /** C2.4 跨账号去重键 */
    dedupKey?: string;
    /** C2.2 本账号意图使用的 xsecToken */
    xsecToken?: string;
    /** 动作能力分级（蓝军 #3），透传至 executeWithAccount */
    capability?: ToolCapability;
    /**
     * A6：本次互动的目标 noteId。若批次账号数 > 1（含 accounts:'all' 解析后），
     * 整批拒绝执行（不落任何账号），避免单次调用把同一篇笔记的写操作打到多个账号形成强关联特征。
     */
    noteId?: string;
  },
): Promise<OperationResult<T>[]> {
  // 确定要使用的账户列表
  let accountNames: string[];

  if (params.accounts === 'all') {
    // 使用所有活跃账户
    const allAccounts = pool.listAccounts().filter((a) => a.status === 'active');
    accountNames = allAccounts.map((a) => a.name);
  } else if (params.accounts && params.accounts.length > 0) {
    // 使用指定的多个账户
    accountNames = params.accounts;
  } else if (params.account) {
    // 使用单个指定账户
    accountNames = [params.account];
  } else {
    // 未指定账户 - 如果只有一个活跃账户则使用它
    const allAccounts = pool.listAccounts().filter((a) => a.status === 'active');
    if (allAccounts.length === 0) {
      return [
        {
          account: 'none',
          success: false,
          error: 'No active accounts found. Use xhs_add_account to add one.',
        },
      ];
    }
    if (allAccounts.length === 1) {
      accountNames = [allAccounts[0].name];
    } else {
      return [
        {
          account: 'none',
          success: false,
          error: `Multiple accounts available. Please specify which account(s) to use: ${allAccounts.map((a) => a.name).join(', ')}`,
        },
      ];
    }
  }

  if (accountNames.length === 0) {
    return [
      {
        account: 'none',
        success: false,
        error: 'No accounts specified.',
      },
    ];
  }

  const cap: ToolCapability = options?.capability ?? 'write';

  // A6：拒绝单次同 note 多账号写——同一 noteId 且批次账号数 > 1，整批拒绝，不执行任何账号
  if (cap === 'write' && options?.noteId && accountNames.length > 1) {
    log.warn('拒绝单次同 note 多账号写', { noteId: options.noteId, accounts: accountNames, action });
    return accountNames.map((name) => ({
      account: pool.getAccount(name)?.name ?? name,
      success: false,
      skipped: true,
      error: `multi_account_same_note_rejected:${options.noteId}`,
      durationMs: 0,
    }));
  }

  // A1：多账号写批次出口硬约束（单账号写不强制；read/control 不检查）
  const proxySkipByName = new Map<string, string>();
  if (cap === 'write' && accountNames.length > 1) {
    const batchAccounts = accountNames.map((name) => {
      const acc = pool.getAccount(name);
      return { name: acc?.name ?? name, proxy: acc?.proxy };
    });
    const { skips, warnings } = evaluateMultiAccountProxyGate(
      batchAccounts,
      config.antiDetect.proxyRequired.mode,
    );
    if (warnings.length > 0) {
      log.warn('多账号写代理门禁告警（warn 模式放行）', { warnings, action });
    }
    for (const s of skips) {
      proxySkipByName.set(s.account, s.reason);
      // 亦按调用方传入的名称索引，避免 name/id 混用漏拦
      const resolved = pool.getAccount(s.account);
      if (resolved) {
        proxySkipByName.set(resolved.name, s.reason);
        proxySkipByName.set(resolved.id, s.reason);
      }
    }
  }

  // 执行操作
  const guard = getCooccurrenceGuard();
  // C2.1 默认开启共现抑制即改为串行；显式 sequential=false 且未启用共现时才并行
  const useSequential = options?.sequential === true || guard.isCooccurrenceEnabled();

  if (useSequential) {
    // 串行执行：按顺序在每个账户上执行，账号间插入随机冷却（C2.1）
    const results: OperationResult<T>[] = [];
    for (let i = 0; i < accountNames.length; i++) {
      const accountName = accountNames[i];
      const proxyReason = proxySkipByName.get(accountName) ?? (() => {
        const acc = pool.getAccount(accountName);
        return acc ? proxySkipByName.get(acc.name) ?? proxySkipByName.get(acc.id) : undefined;
      })();
      if (proxyReason) {
        results.push({
          account: pool.getAccount(accountName)?.name ?? accountName,
          success: false,
          skipped: true,
          error: proxyReason,
          durationMs: 0,
        });
        continue;
      }
      const result = await executeWithAccount(pool, db, accountName, action, operation, options);
      results.push(result);

      // C2.3 熔断触发（蓝军 #5：以 afterAction 返回的 trippedNow 即时判定）：
      // 取消剩余队列，进入人工，不继续对其他账号动作。
      if (result.trippedNow) {
        log.warn('熔断触发，取消剩余多账号队列', { trippedAt: accountName });
        for (let j = i + 1; j < accountNames.length; j++) {
          results.push({
            account: accountNames[j],
            success: false,
            skipped: true,
            error: 'queue_cancelled_circuit_breaker',
            durationMs: 0,
          });
        }
        break;
      }

      // 账号间冷却（最后一个账号后不等待）
      if (i < accountNames.length - 1) {
        const cooldown = guard.interAccountCooldownMs();
        if (cooldown > 0) {
          log.info('账号间冷却（共现抑制）', { ms: cooldown });
          await sleep(cooldown);
        }
      }
    }
    return results;
  } else {
    // 并行执行：同时在所有账户上执行
    const promises = accountNames.map(async (accountName) => {
      const proxyReason = proxySkipByName.get(accountName) ?? (() => {
        const acc = pool.getAccount(accountName);
        return acc ? proxySkipByName.get(acc.name) ?? proxySkipByName.get(acc.id) : undefined;
      })();
      if (proxyReason) {
        return {
          account: pool.getAccount(accountName)?.name ?? accountName,
          success: false,
          skipped: true,
          error: proxyReason,
          durationMs: 0,
        } satisfies OperationResult<T>;
      }
      return executeWithAccount(pool, db, accountName, action, operation, options);
    });
    return Promise.all(promises);
  }
}

/**
 * 从参数中解析账户选择
 *
 * 如果未指定账户且只有一个活跃账户，则使用该账户。
 *
 * @param pool - 账户池实例
 * @param params - 账户选择参数
 * @returns 解析后的账户名称或错误信息
 */
export function resolveAccount(
  pool: AccountPool,
  params: MultiAccountParams,
): { account: string | null; error?: string } {
  if (params.account) {
    const account = pool.getAccount(params.account);
    if (!account) {
      return { account: null, error: `Account not found: ${params.account}` };
    }
    return { account: account.name };
  }

  // Try to use default if only one account exists
  const allAccounts = pool.listAccounts().filter((a) => a.status === 'active');
  if (allAccounts.length === 0) {
    return { account: null, error: 'No active accounts. Use xhs_add_account to add one.' };
  }
  if (allAccounts.length === 1) {
    return { account: allAccounts[0].name };
  }

  return {
    account: null,
    error: `Multiple accounts available. Please specify which account to use: ${allAccounts.map((a) => a.name).join(', ')}`,
  };
}
