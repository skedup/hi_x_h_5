/**
 * @fileoverview C6：evalMainState / evalDom 执行世界封装单测。
 * @module xhs/utils/page-eval.test
 */
import '../../core/logger.js';
import { describe, it, expect } from 'bun:test';
import { evalMainState, evalDom, waitForMainState, waitForDom, isFatalPageEvalError } from './page-eval.js';

function makePage(record: { isolated?: boolean }[]) {
  return {
    evaluate: async (fn: any, arg: any, isolated?: boolean) => {
      record.push({ isolated });
      return await fn(arg);
    },
  } as any;
}

describe('C6 page-eval 执行世界', () => {
  it('evalMainState 固定 isolatedContext=false', async () => {
    const calls: { isolated?: boolean }[] = [];
    const page = makePage(calls);
    const v = await evalMainState(page, (x: number) => x + 1, 41);
    expect(v).toBe(42);
    expect(calls[0].isolated).toBe(false);
  });

  it('evalDom 固定 isolatedContext=true', async () => {
    const calls: { isolated?: boolean }[] = [];
    const page = makePage(calls);
    const v = await evalDom(page, () => 'dom', null);
    expect(v).toBe('dom');
    expect(calls[0].isolated).toBe(true);
  });

  it('waitForMainState 在条件变真时返回', async () => {
    const calls: { isolated?: boolean }[] = [];
    let n = 0;
    const page = {
      evaluate: async (_fn: any, _arg: any, isolated?: boolean) => {
        calls.push({ isolated });
        n += 1;
        return n >= 2;
      },
    } as any;
    await waitForMainState(page, () => true, null, { timeout: 2000, pollingIntervalMs: 10 });
    expect(calls.every((c) => c.isolated === false)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('waitForDom 超时抛错', async () => {
    const page = {
      evaluate: async () => false,
    } as any;
    await expect(waitForDom(page, () => false, null, { timeout: 50, pollingIntervalMs: 10 })).rejects.toThrow(
      /waitForDom timed out/,
    );
  });

  it('isFatalPageEvalError 识别 closed / 放过 context destroyed', () => {
    expect(isFatalPageEvalError(new Error('Target page, context or browser has been closed'))).toBe(true);
    expect(isFatalPageEvalError(new Error('Target closed'))).toBe(true);
    expect(isFatalPageEvalError(new Error('Execution context was destroyed, most likely because of a navigation'))).toBe(
      false,
    );
  });

  it('waitForMainState 遇页面已关闭立即抛出，不空转超时', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('Target page, context or browser has been closed');
      },
    } as any;
    const start = Date.now();
    await expect(waitForMainState(page, () => true, null, { timeout: 5000, pollingIntervalMs: 100 })).rejects.toThrow(
      /has been closed/,
    );
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
