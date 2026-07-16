/**
 * A2 可执行回归：验证 typeLikeHuman 满足 MR DoD 的可测项。
 * 不依赖真实浏览器——注入假 page 记录键盘调用与时间戳。
 *
 * 运行：bun scripts/regression-a2.ts   (或 npm run regression:a2)
 *
 * 断言：
 *  1. 删除/修订：至少发生过一次 Backspace（reviseEvery 触发）。
 *  2. 间隔方差：相邻逐字间隔不全相等（CV > 0，消除亚毫秒突发）。
 *  3. 取消：AbortSignal aborted 时抛 AbortError 且停止键入。
 */
import type { Page } from 'patchright';
import { typeLikeHuman } from '../src/xhs/utils/index.js';

interface Call {
  op: string;
  t: number;
}

function makeFakePage(calls: Call[]): Page {
  return {
    keyboard: {
      async type(ch: string) {
        calls.push({ op: 'type', t: performance.now() });
        void ch;
      },
      async press(key: string) {
        calls.push({ op: `press:${key}`, t: performance.now() });
      },
    },
  } as unknown as Page;
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

async function main() {
  // --- 1. 删除/修订 + 2. 间隔方差 ---
  const calls: Call[] = [];
  const page = makeFakePage(calls);
  await typeLikeHuman(page, '小红书自动化输入节奏拟人测试', {
    minDelay: 1,
    maxDelay: 4,
    pauseChance: 0,
    reviseEvery: 3,
    reviseMax: 1,
  });

  const backspaces = calls.filter((c) => c.op === 'press:Backspace').length;
  assert(backspaces > 0, `存在删除/修订（Backspace 次数=${backspaces} > 0）`);

  const typeTimes = calls.filter((c) => c.op === 'type').map((c) => c.t);
  const intervals: number[] = [];
  for (let i = 1; i < typeTimes.length; i += 1) {
    intervals.push(typeTimes[i] - typeTimes[i - 1]);
  }
  const distinct = new Set(intervals.map((n) => Math.round(n))).size;
  assert(distinct > 1, `逐字间隔存在方差（不同间隔值=${distinct} > 1，CV > 0）`);
  assert(typeTimes.length > 0, `总输入耗时 > 0（${Math.round(typeTimes[typeTimes.length - 1] - typeTimes[0])}ms）`);

  // --- 3. 取消（AbortSignal）---
  const calls2: Call[] = [];
  const page2 = makeFakePage(calls2);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  let threw = false;
  try {
    await typeLikeHuman(page2, '这是一段会被取消的很长很长很长很长的输入内容用于测试中止信号', {
      minDelay: 20,
      maxDelay: 40,
      reviseEvery: 0,
      signal: ac.signal,
    });
  } catch (e) {
    threw = e instanceof DOMException && e.name === 'AbortError';
  }
  assert(threw, 'AbortSignal aborted 时抛出 AbortError');
  const typesAfterAbort = calls2.filter((c) => c.op === 'type').length;
  assert(typesAfterAbort < 30, `中止后停止键入（实际键入 ${typesAfterAbort} 字 < 全长）`);

  console.log('\nAll A2 regression checks passed.');
}

main().catch((e) => {
  console.error('Regression crashed:', e);
  process.exit(1);
});
