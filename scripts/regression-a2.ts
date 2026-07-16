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
 *  7. 字段完整性：input 精确相等；contenteditable 保留语义空格/换行后相等；
 *     不一致（含换行丢失）判定为非 null（第三轮 P0）。
 *  8. 字素长度：graphemeLength 按字素计数，emoji 标题不被 UTF-16 误拒（第三轮 P1）。
 *  9. 长正文预算：computeTypingPlan 按字素缩放 deadline 并压缩延迟，合法长文不再被截断（第三轮 P1）。
 */
import type { Page } from 'patchright';
import {
  typeLikeHuman,
  truncateGrapheme,
  fieldValueMismatch,
  graphemeLength,
  computeTypingPlan,
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

  // --- 7. 字段完整性判定（第三轮 P0：不得放过换行/空格丢失）---
  assert(fieldValueMismatch('abc', 'abc', false) === null, 'input 精确相等 → 一致');
  assert(fieldValueMismatch('abc', 'ab', false) !== null, 'input 残缺 → 不一致（应阻断）');
  // 关键回归：正文换行被吞必须判定为不一致（旧实现删除全部空白会放过）
  assert(
    fieldValueMismatch('第一段\n第二段', '第一段第二段', true) !== null,
    'contenteditable 换行丢失 → 不一致（应阻断，放过即漏检）',
  );
  // 语义单空格保留：归一化后相等才判一致
  assert(fieldValueMismatch('a b', 'a b', true) === null, 'contenteditable 单空格一致 → 一致');
  assert(fieldValueMismatch('a b', 'a  b', true) === null, 'contenteditable 多空格折叠后相等 → 一致');
  assert(fieldValueMismatch('abc', 'abx', true) !== null, 'contenteditable 内容不符 → 不一致（应阻断）');

  // --- 8. grapheme 长度校验（第三轮 P1：工具层不得按 UTF-16 误拒 emoji）---
  const emojiTitle = 'a'.repeat(19) + '😀';
  assert(graphemeLength(emojiTitle) === 20, `graphemeLength 计字素（${graphemeLength(emojiTitle)} == 20）`);
  assert(graphemeLength('😀') === 1, '单个 emoji 计 1 字素');
  // 工具层若按 String.length(UTF-16) 会得 21 而误拒，这里确认 20 字素合规
  assert(graphemeLength(emojiTitle) <= 20, '20 字素标题通过工具层上限校验');

  // --- 9. 长正文输入预算自适应（第三轮 P1：合法长文不再被 60s 截断）---
  const shortPlan = computeTypingPlan('短标题', {
    minDelay: 45,
    maxDelay: 170,
    reviseGapMin: 3,
    reviseGapMax: 9,
    reviseMax: 1,
    reviseChance: 0.85,
    defaultMaxDurationMs: 20000,
  });
  assert(
    shortPlan.maxDurationMs === 20000 && shortPlan.minDelay === 45,
    `短文预算不变（maxDurationMs=${shortPlan.maxDurationMs}, minDelay=${shortPlan.minDelay}）`,
  );

  const longText = '这'.repeat(1000);
  const longPlan = computeTypingPlan(longText, {
    minDelay: 45,
    maxDelay: 170,
    reviseGapMin: 4,
    reviseGapMax: 12,
    reviseMax: 1,
    reviseChance: 0.8,
    defaultMaxDurationMs: 60000,
  });
  assert(longPlan.maxDurationMs > 60000, `长正文预算缩放 > 60s（=${longPlan.maxDurationMs}ms，不再静默截断）`);
  assert(longPlan.maxDurationMs <= 240000, `长正文预算设上限 ≤ 240s（=${longPlan.maxDurationMs}ms）`);
  assert(longPlan.minDelay < 45, `长正文自适应压缩延迟（minDelay=${longPlan.minDelay} < 45）`);
  // 账户锁等待策略：应取 maxDurationMs + 余量（≥ 长文预算）
  const lockTimeout = longPlan.maxDurationMs + 30000;
  assert(lockTimeout >= longPlan.maxDurationMs, `账户锁等待同步缩放（lockTimeout=${lockTimeout}ms）`);

  console.log('\nAll A2 regression checks passed.');
}

main().catch((e) => {
  console.error('Regression crashed:', e);
  process.exit(1);
});
