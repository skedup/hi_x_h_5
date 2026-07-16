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

  // 蓝军 #1：非 active 账号（如 migration_required / suspended / banned）拒绝平台操作；
  // 恢复路径 xhs_add_account 不经此汇聚点，不受影响。
  if (account.status !== 'active') {
    return {
      account: account.name,
      success: false,
      skipped: true,
      error: `account_inactive:${account.status ?? 'unknown'}`,
      durationMs: 0,
    };
  }

  // C3.2 息屏/无人值守自保：写操作需设备在场，否则停写（仅 shadow/停止）
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

  // B1 headless 门禁：写操作拒绝 headless（强制 headful 以保留设备在场语义）
  if (config.antiDetect.headlessWriteGate.enabled && config.browser.headless) {
    return {
      account: account?.name ?? accountIdOrName,
      success: false,
      skipped: true,
      error: 'headless_write_blocked',
      durationMs: 0,
    };
  }

  // C2.1/C2.2/C2.3/C2.4 动作前核查：预算/冷却/熔断/去重/xsec 绑定
  const guard = getCooccurrenceGuard();
  const before = guard.beforeAction({
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

  const startTime = Date.now();
  let release: (() => void) | null = null;
  let outcome: { success: boolean; error?: string; result?: T } = { success: false };

  try {
    // Acquire lock
    release = await pool.acquireLock(account.id, action, options?.lockTimeout);

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

  // C2.3/C2.4/C2.2 动作后回填：预算/熔断/去重/token 绑定
  guard.afterAction({
    accountId: account.id,
    action,
    success: outcome.success,
    error: outcome.error,
    result: outcome.result,
    dedupKey: options?.dedupKey,
    xsecToken: options?.xsecToken,
  });

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

  // 执行操作
  const guard = getCooccurrenceGuard();
  // C2.1 默认开启共现抑制即改为串行；显式 sequential=false 且未启用共现时才并行
  const useSequential = options?.sequential === true || guard.isCooccurrenceEnabled();

  if (useSequential) {
    // 串行执行：按顺序在每个账户上执行，账号间插入随机冷却（C2.1）
    const results: OperationResult<T>[] = [];
    for (let i = 0; i < accountNames.length; i++) {
      const accountName = accountNames[i];
      const result = await executeWithAccount(pool, db, accountName, action, operation, options);
      results.push(result);

      // C2.3 熔断触发：取消剩余队列，进入人工（不继续对其他账号动作）
      if (result.skipped && result.error === 'circuit_breaker_tripped') {
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
    const promises = accountNames.map((accountName) =>
      executeWithAccount(pool, db, accountName, action, operation, options),
    );
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
