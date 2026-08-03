/**
 * @fileoverview C6：页面 evaluate / 等待的执行世界策略。
 *
 * 标准：
 * - **主世界（main）**：读 `__INITIAL_STATE__` 等页面全局 JS 状态 → `evalMainState` / `waitForMainState`
 * - **隔离世界（isolated）**：纯 DOM 查询/滚动度量，不依赖页面脚本状态 → `evalDom`
 *
 * patchright：`page.evaluate(fn, arg?, isolatedContext=true)`；`false` = main。
 * `waitForFunction` **无** world 开关且服务端默认 main —— 禁止裸用读状态；统一走 `waitForMainState`
 *（内部用主世界 evaluate 轮询，世界选择显式可检）。
 *
 * @module xhs/utils/page-eval
 */

import type { Page } from 'patchright';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 主世界等待默认超时 / 轮询间隔 */
const WAIT_DEFAULTS = {
  TIMEOUT_MS: 30_000,
  POLL_MS: 100,
} as const;

type PageFn<Arg, R> = (arg: Arg) => R | Promise<R>;

/**
 * 主世界 evaluate：仅用于读页面 JS 状态（如 `__INITIAL_STATE__`）。
 * 固定 `isolatedContext=false`；统一传 arg，避免 boolean arg 与 world 标志混淆。
 */
export async function evalMainState<Arg, R>(
  page: Page,
  pageFunction: PageFn<Arg, R>,
  arg: Arg,
): Promise<R> {
  return (page.evaluate as (fn: PageFn<Arg, R>, a: Arg, isolated: boolean) => Promise<R>)(
    pageFunction,
    arg,
    false,
  );
}

/**
 * 隔离世界 evaluate：DOM / 布局等不依赖页面全局状态。
 * 显式 `isolatedContext=true`（与 patchright 默认一致，但调用点语义自解释）。
 */
export async function evalDom<Arg, R>(
  page: Page,
  pageFunction: PageFn<Arg, R>,
  arg: Arg,
): Promise<R> {
  return (page.evaluate as (fn: PageFn<Arg, R>, a: Arg, isolated: boolean) => Promise<R>)(
    pageFunction,
    arg,
    true,
  );
}

export interface WaitForMainStateOptions {
  /** 超时毫秒，默认 30000 */
  timeout?: number;
  /** 轮询间隔毫秒，默认 100 */
  pollingIntervalMs?: number;
}

/**
 * 等待主世界条件成立。
 *
 * 不使用裸 `page.waitForFunction`（无 world API、隐式 main）；改为 `evalMainState` 轮询，
 * 使「主世界读状态」在调用栈上可审计。
 *
 * @param pageFunction 返回 truthy 即成功（与 waitForFunction 语义对齐）
 */
export async function waitForMainState<Arg>(
  page: Page,
  pageFunction: PageFn<Arg, unknown>,
  arg: Arg,
  options: WaitForMainStateOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? WAIT_DEFAULTS.TIMEOUT_MS;
  const interval = options.pollingIntervalMs ?? WAIT_DEFAULTS.POLL_MS;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const value = await evalMainState(page, pageFunction, arg);
      if (value) return;
    } catch {
      // 导航中途 evaluate 可能短暂失败，继续轮询直至超时
    }
    await sleep(interval);
  }

  throw new Error(`waitForMainState timed out after ${timeout}ms`);
}

/**
 * 等待隔离世界 DOM 条件成立（轮询 `evalDom`）。
 * 用于不依赖 `__INITIAL_STATE__` 的 DOM 结果检测（如输入框清空）。
 */
export async function waitForDom<Arg>(
  page: Page,
  pageFunction: PageFn<Arg, unknown>,
  arg: Arg,
  options: WaitForMainStateOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? WAIT_DEFAULTS.TIMEOUT_MS;
  const interval = options.pollingIntervalMs ?? WAIT_DEFAULTS.POLL_MS;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const value = await evalDom(page, pageFunction, arg);
      if (value) return;
    } catch {
      // 忽略短暂失败
    }
    await sleep(interval);
  }

  throw new Error(`waitForDom timed out after ${timeout}ms`);
}

/**
 * 等待 `window.__INITIAL_STATE__` 出现（主世界）。
 */
export async function waitForInitialState(
  page: Page,
  options: WaitForMainStateOptions = {},
): Promise<void> {
  await waitForMainState(
    page,
    () => (window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ !== undefined,
    null,
    options,
  );
}
