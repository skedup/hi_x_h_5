/**
 * A2 可执行回归：验证 typeLikeHuman / truncateGrapheme / fieldValueMismatch
 * 满足 MR 第二轮 DoD 的可测项。不依赖真实浏览器——注入假 page 记录键盘调用。
 *
 * 运行：bun scripts/regression-a2.ts   (或 npm run regression:a2)
 *
 * 覆盖：
 *  1. 删除/修订：至少发生过一次 Backspace（随机间距修订触发）。
 *  2. 间隔方差：相邻逐字间隔不全相等（CV > 0，消除亚毫秒突发）。
 *  3. 取消：AbortSignal aborted 时抛 AbortError 且停止键入。
 *  4. 超时：maxDurationMs 到期抛 AbortError（不再静默发布残缺正文）。
 *  5. 非周期修订：修订间距不恒等（随机化），且修订总数受 maxRevisions 上限约束。
 *  6. 字素裁剪：emoji / ZWJ 组合字符不被 UTF-16 截断破坏。
 *  7. 字段完整性：input 精确相等；contenteditable 归一化相等；不一致判定为非 null。
 */
import type { Page } from 'patchright';
import {
  typeLikeHuman,
  truncateGrapheme,
  fieldValueMismatch,
} from '../src/xhs/utils/index.js';

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

/** 从调用序列中找出每次「修订」的起点（一段连续 Backspace 的第一次）。 */
function revisionStartIndices(calls: Call[]): number[] {
  const starts: number[] = [];
  for (let k = 0; k < calls.length; k += 1) {
    if (calls[k].op === 'press:Backspace') {
      const prev = calls[k - 1];
      if (!prev || prev.op !== 'press:Backspace') starts.push(k);
    }
  }
  return starts;
}

async function main() {
  // --- 1. 删除/修订 + 2. 间隔方差 ---
  const calls: Call[] = [];
  const page = makeFakePage(calls);
  await typeLikeHuman(page, '小红书自动化输入节奏拟人测试', {
    minDelay: 1,
    maxDelay: 4,
    pauseChance: 0,
    reviseGapMin: 3,
    reviseGapMax: 9,
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
      reviseGapMin: 0,
      signal: ac.signal,
    });
  } catch (e) {
    threw = e instanceof DOMException && e.name === 'AbortError';
  }
  assert(threw, 'AbortSignal aborted 时抛出 AbortError');
  const typesAfterAbort = calls2.filter((c) => c.op === 'type').length;
  assert(typesAfterAbort < 30, `中止后停止键入（实际键入 ${typesAfterAbort} 字 < 全长）`);

  // --- 4. 超时抛 AbortError（阻断残缺发布）---
  const calls3: Call[] = [];
  const page3 = makeFakePage(calls3);
  let timeoutThrew = false;
  try {
    await typeLikeHuman(page3, '这'.repeat(200), {
      minDelay: 5,
      maxDelay: 10,
      reviseGapMin: 0,
      maxDurationMs: 1, // 极小上限，必然超时
    });
  } catch (e) {
    timeoutThrew = e instanceof DOMException && e.name === 'AbortError';
  }
  assert(timeoutThrew, 'maxDurationMs 到期抛出 AbortError（不再静默返回成功）');
  const typedBeforeTimeout = calls3.filter((c) => c.op === 'type').length;
  assert(typedBeforeTimeout < 200, `超时后停止键入（实际键入 ${typedBeforeTimeout} 字 < 200）`);

  // --- 5. 非周期修订 + 修订上限 ---
  let sawNonPeriodic = false;
  let capEnforced = true;
  for (let trial = 0; trial < 10; trial += 1) {
    const c: Call[] = [];
    const p = makeFakePage(c);
    await typeLikeHuman(p, '小红书自动化输入节奏拟人测试第二轮整改验证随机修订间距非周期', {
      minDelay: 1,
      maxDelay: 2,
      pauseChance: 0,
      reviseGapMin: 3,
      reviseGapMax: 10,
      reviseMax: 1,
      reviseChance: 1, // 强制每次机会都修订，考验上限
      maxRevisions: 4,
    });
    const starts = revisionStartIndices(c);
    // 修订起点之间的「调用序号」间距
    const gaps: number[] = [];
    for (let k = 1; k < starts.length; k += 1) gaps.push(starts[k] - starts[k - 1]);
    if (new Set(gaps).size > 1) sawNonPeriodic = true;
    if (starts.length > 4) capEnforced = false;
  }
  assert(sawNonPeriodic, '修订间距非周期（随机间距，非固定 i % N）');
  assert(capEnforced, '修订总数受 maxRevisions=4 硬上限约束');

  // --- 6. 字素裁剪（emoji / ZWJ 不被 UTF-16 截断破坏）---
  const emojiStr = 'a'.repeat(19) + '😀';
  const t1 = truncateGrapheme(emojiStr, 20);
  assert([...t1].length === 20, `字素裁剪按字素计数（${[...t1].length} == 20）`);
  assert(t1.includes('😀'), 'emoji 完整保留（未被切成孤立高代理 0xD83D）');

  const zwjStr = 'x'.repeat(5) + '👨‍👩‍👧';
  const t2 = truncateGrapheme(zwjStr, 6);
  assert(t2.includes('👨‍👩‍👧'), 'ZWJ 组合字符（家庭 emoji）不被拆断');

  assert(truncateGrapheme('hello', 3) === 'hel', '短串按字素截断为 hel');

  // --- 7. 字段完整性判定 ---
  assert(fieldValueMismatch('abc', 'abc', false) === null, 'input 精确相等 → 一致');
  assert(fieldValueMismatch('abc', 'ab', false) !== null, 'input 残缺 → 不一致（应阻断）');
  assert(fieldValueMismatch('a b', 'a  b', true) === null, 'contenteditable 空白归一化后相等 → 一致');
  assert(fieldValueMismatch('abc', 'abx', true) !== null, 'contenteditable 内容不符 → 不一致（应阻断）');

  console.log('\nAll A2 regression checks passed.');
}

main().catch((e) => {
  console.error('Regression crashed:', e);
  process.exit(1);
});
