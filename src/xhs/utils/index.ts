/**
 * @fileoverview Utility functions for browser automation.
 * Includes human-like scrolling and helper functions.
 * @module xhs/utils
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { Page, ElementHandle, Locator, APIRequestContext } from 'patchright';
import { config, paths } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { downloadFile } from '../../core/account-download.js';
import { evalDom } from './page-eval.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const log = createLogger('xhs-utils');

/**
 * Sleep for a specified duration.
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带抖动的等待，打破固定时钟尖峰（蓝军报告 03 §P1-1/§P1-4）。
 * 仍走真实 setTimeout，仅把间隔随机化，避免平台建立时钟指纹。
 * 对长等待（>=2000ms，多为页面加载/上传/发布成功等待）自动收紧抖动系数，
 * 防止被抖得过短导致功能失败（视频上传、发布轮询等）。
 *
 * 注意：本函数做**对称**抖动（±ratio），只用于非限流类的节奏等待
 * （页面就绪、轮询间隔等）。承担限流的 REQUEST_INTERVAL 必须用
 * `rateLimitedSleep`，禁止用本函数，否则最早请求会比配置值提前，
 * 违反 A4 DoD 的"安全下限"。
 *
 * @param base - 基准毫秒数
 * @param ratio - 抖动幅度（默认 0.4，即 ±40%）；长等待自动限到 0.2
 */
export async function jitteredSleep(base: number, ratio = 0.4): Promise<void> {
  const r = base >= 2000 ? Math.min(ratio, 0.2) : ratio;
  const factor = 1 + (Math.random() * 2 - 1) * r;
  await sleep(Math.max(1, Math.round(base * factor)));
}

/**
 * 限流专用等待：仅**正向**抖动，结果永远 >= 配置下限 base。
 * 用于承担限流职责的 REQUEST_INTERVAL——最早一次请求也绝不比配置值提前，
 * 保证限流安全（蓝军报告 / A4 DoD "变量区间 + 安全下限"）。
 * 一旦提前触发请求，限流就失效，故此处刻意不做对称抖动。
 *
 * @param base - 基准毫秒数（安全下限，请求至少等待这么久）
 * @param ratio - 正向抖动幅度（默认 0.4，即 [base, base*1.4]）
 */
export async function rateLimitedSleep(base: number, ratio = 0.4): Promise<void> {
  await sleep(Math.round(base * (1 + Math.random() * ratio)));
}

/**
 * 标准正态 N(0,1)（Box-Muller）。
 */
function randomNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface HeavyTailDelayOptions {
  /** 对数正态 σ，默认取 config.antiDetect.heavyTail.sigma */
  sigma?: number;
  /** 下限毫秒（含） */
  minMs?: number;
  /** 上限毫秒（含）；默认 base * maxMultiplier */
  maxMs?: number;
}

/**
 * 采样行为重尾延迟毫秒数：中位数约等于 `base` 的对数正态，右尾偶发更长停顿。
 * `XHS_MCP_AD_HEAVY_TAIL=false` 时：有 min/max 则在该区间均匀；否则 [0.8base, 1.2base]。
 * **仅**用于拟人节奏；功能等待用 `jitteredSleep`，限流用 `rateLimitedSleep`。
 */
export function sampleHeavyTailMs(base: number, options: HeavyTailDelayOptions = {}): number {
  const ht = config.antiDetect.heavyTail;
  const floor = Math.max(1, Math.round(options.minMs ?? 1));
  const cap = Math.max(
    floor,
    Math.round(options.maxMs ?? Math.max(base, 1) * (ht?.maxMultiplier ?? 8)),
  );
  const b = Math.max(1, base);

  if (!ht?.enabled) {
    // 关闭时：若调用方给了 [minMs, maxMs] 则在该区间均匀采样（对齐迁移前分布）；
    // 否则退回 base 的 ±20% 窄带。
    if (options.minMs !== undefined && options.maxMs !== undefined) {
      const lo = Math.max(1, Math.round(options.minMs));
      const hi = Math.max(lo, Math.round(options.maxMs));
      return Math.floor(lo + Math.random() * (hi - lo + 1));
    }
    const lo = Math.max(floor, Math.round(b * 0.8));
    const hi = Math.min(cap, Math.max(lo, Math.round(b * 1.2)));
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  }

  const sigma = options.sigma ?? ht.sigma ?? 0.45;
  const mu = Math.log(b);
  const sample = Math.exp(mu + sigma * randomNormal());
  return Math.max(floor, Math.min(cap, Math.round(sample)));
}

/**
 * 行为重尾等待（B1）。见 `sampleHeavyTailMs`。
 */
export async function heavyTailDelay(base: number, options?: HeavyTailDelayOptions): Promise<void> {
  await sleep(sampleHeavyTailMs(base, options));
}

/**
 * 在 [minMs, maxMs] 内做重尾采样（几何均值为中位近似）。
 */
export async function heavyTailDelayBetween(minMs: number, maxMs: number): Promise<void> {
  const lo = Math.max(1, Math.min(minMs, maxMs));
  const hi = Math.max(lo, Math.max(minMs, maxMs));
  const base = Math.sqrt(lo * hi);
  await heavyTailDelay(base, { minMs: lo, maxMs: hi });
}

/** B2：最近一次轨迹点击元数据（测辅 / DoD 可观测） */
export interface TrajectoryClickMeta {
  steps: number;
  usedForce: boolean;
  from: { x: number; y: number };
  to: { x: number; y: number };
  disabled: boolean;
}

let lastTrajectoryMeta: TrajectoryClickMeta | null = null;

/** 读取最近一次 `clickWithTrajectory` 元数据（测试用） */
export function getLastTrajectoryMeta(): TrajectoryClickMeta | null {
  return lastTrajectoryMeta;
}

export interface ClickWithTrajectoryOptions {
  /** 轨迹步数；启用时强制 ≥ minSteps（默认 5） */
  steps?: number;
  /** 最小步数下限（默认 config / 5） */
  minSteps?: number;
  /** 到达后 hover 停顿基准 ms（默认 80，走重尾） */
  hoverDwellMs?: number;
  /**
   * 仅当常规轨迹点击失败时允许 force 直点（会 warn）。
   * 默认 false——禁止默认 force。
   */
  allowForceFallback?: boolean;
  button?: 'left' | 'right' | 'middle';
}

function cubicBezier(
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** 进程内记录上次鼠标位置，供下一次轨迹起点（无则用视口随机角落） */
let lastMousePos: { x: number; y: number } | null = null;

/** ElementHandle / Locator / 视口坐标 */
export type ClickTarget = ElementHandle | Locator | { x: number; y: number };

function isClickableTarget(
  target: ClickTarget,
): target is ElementHandle | Locator {
  return typeof (target as ElementHandle | Locator).boundingBox === 'function';
}

/** 对齐 Playwright click：先滚入视口再取坐标，避免屏外/过期 box */
async function ensureTargetInView(target: ClickTarget): Promise<void> {
  if (!isClickableTarget(target)) return;
  const scroll = (target as ElementHandle | Locator).scrollIntoViewIfNeeded;
  if (typeof scroll === 'function') {
    await scroll.call(target).catch(() => {});
  }
}

async function resolveClickPoint(
  target: ClickTarget,
): Promise<{ x: number; y: number } | null> {
  if (isClickableTarget(target)) {
    const box = await target.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const ox = (Math.random() - 0.5) * box.width * 0.4;
    const oy = (Math.random() - 0.5) * box.height * 0.4;
    return {
      x: box.x + box.width / 2 + ox,
      y: box.y + box.height / 2 + oy,
    };
  }
  return { x: target.x, y: target.y };
}

/**
 * 落点是否打在目标（或其子节点）上；被遮罩时 elementFromPoint 会指向上层。
 * 检测失败时返回 null（调用方勿据此 force）。
 */
async function isPointHittingTarget(
  target: ElementHandle | Locator,
  x: number,
  y: number,
): Promise<boolean | null> {
  try {
    return await (target as Locator).evaluate(
      (el, coords: { x: number; y: number }) => {
        const top = document.elementFromPoint(coords.x, coords.y);
        if (!top) return false;
        return el === top || el.contains(top) || top.contains(el);
      },
      { x, y },
    );
  } catch {
    return null;
  }
}

function forceFallbackMeta(
  steps: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): TrajectoryClickMeta {
  const meta: TrajectoryClickMeta = {
    steps,
    usedForce: true,
    from,
    to,
    disabled: false,
  };
  lastTrajectoryMeta = meta;
  return meta;
}

/**
 * B2：多步 Bezier 指针轨迹 + hover dwell 后点击（Fitts 风格步数）。
 * DoD：启用时 `steps ≥ minSteps`（默认 5），`getLastTrajectoryMeta()` 可观测。
 * 默认禁 force；仅 `allowForceFallback` 在无 box / 遮罩命中失败 / mouse 抛错时 force+warn。
 * 回滚：`XHS_MCP_AD_TRAJECTORY=false` → 元素/坐标直点。
 */
export async function clickWithTrajectory(
  page: Page,
  target: ClickTarget,
  options: ClickWithTrajectoryOptions = {},
): Promise<TrajectoryClickMeta> {
  const traj = config.antiDetect.trajectory;
  const minSteps = Math.max(1, options.minSteps ?? traj?.minSteps ?? 5);
  const button = options.button ?? 'left';

  await ensureTargetInView(target);
  const point = await resolveClickPoint(target);

  if (!traj?.enabled) {
    if (isClickableTarget(target)) {
      // 直点走 Playwright click（自带 actionability / 再滚一次），比裸坐标更稳
      await target.click({ button });
    } else if (point) {
      await page.mouse.click(point.x, point.y, { button });
      lastMousePos = point;
    } else {
      throw new Error('clickWithTrajectory: invalid target when trajectory disabled');
    }
    const meta: TrajectoryClickMeta = {
      steps: 1,
      usedForce: false,
      from: lastMousePos ?? { x: 0, y: 0 },
      to: point ?? { x: 0, y: 0 },
      disabled: true,
    };
    lastTrajectoryMeta = meta;
    return meta;
  }

  if (!point) {
    if (options.allowForceFallback && isClickableTarget(target)) {
      log.warn('B2 轨迹：无法取得 boundingBox，force fallback');
      await target.click({ force: true, button });
      return forceFallbackMeta(0, lastMousePos ?? { x: 0, y: 0 }, { x: 0, y: 0 });
    }
    throw new Error('clickWithTrajectory: element has no bounding box');
  }

  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const from = lastMousePos ?? {
    x: randomBetween(40, Math.max(80, viewport.width * 0.25)),
    y: randomBetween(40, Math.max(80, viewport.height * 0.25)),
  };

  // Fitts：距离越大步数略增，但不少于 minSteps
  const dist = Math.hypot(point.x - from.x, point.y - from.y);
  const fittsSteps = Math.ceil(Math.log2(dist / 50 + 1) * 3);
  const steps = Math.max(minSteps, options.steps ?? fittsSteps);

  // 三次 Bezier 控制点（轻微弧线，避免直线插值指纹）
  const cx1 = from.x + (point.x - from.x) * (0.25 + Math.random() * 0.2) + (Math.random() - 0.5) * dist * 0.25;
  const cy1 = from.y + (point.y - from.y) * (0.1 + Math.random() * 0.2) + (Math.random() - 0.5) * dist * 0.3;
  const cx2 = from.x + (point.x - from.x) * (0.55 + Math.random() * 0.25) + (Math.random() - 0.5) * dist * 0.2;
  const cy2 = from.y + (point.y - from.y) * (0.6 + Math.random() * 0.25) + (Math.random() - 0.5) * dist * 0.25;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = cubicBezier(t, from.x, cx1, cx2, point.x);
    const y = cubicBezier(t, from.y, cy1, cy2, point.y);
    await page.mouse.move(x, y);
    if (i < steps) {
      await heavyTailDelay(12, { minMs: 4, maxMs: 28 });
    }
  }

  const hoverBase = options.hoverDwellMs ?? 80;
  await heavyTailDelay(hoverBase, {
    minMs: Math.max(20, Math.round(hoverBase * 0.5)),
    maxMs: Math.round(hoverBase * 2.5),
  });

  // 遮罩命中检测须在 mouse down 之前：否则会先点到上层再「成功」
  if (isClickableTarget(target)) {
    const hitting = await isPointHittingTarget(target, point.x, point.y);
    if (hitting === false) {
      if (options.allowForceFallback) {
        log.warn('B2 轨迹：落点被遮罩，force fallback');
        await target.click({ force: true, button });
        lastMousePos = point;
        return forceFallbackMeta(steps, from, point);
      }
      log.warn('B2 轨迹：落点可能被遮罩，仍尝试 mouse 点击（未开 allowForceFallback）');
    }
  }

  try {
    await page.mouse.down({ button });
    await heavyTailDelay(40, { minMs: 15, maxMs: 90 });
    await page.mouse.up({ button });
  } catch (err) {
    if (options.allowForceFallback && isClickableTarget(target)) {
      log.warn('B2 轨迹 mouse 点击失败，force fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      await target.click({ force: true, button });
      lastMousePos = point;
      return forceFallbackMeta(steps, from, point);
    }
    throw err;
  }

  lastMousePos = point;
  const meta: TrajectoryClickMeta = {
    steps,
    usedForce: false,
    from,
    to: point,
    disabled: false,
  };
  lastTrajectoryMeta = meta;
  return meta;
}

/**
 * 按字素簇（grapheme cluster）裁剪长度，避免 UTF-16 code unit 截断破坏
 * emoji / 代理对 / 组合字符（第二轮 P1：String.slice 会留下孤立高代理 0xD83D）。
 * 优先用 Intl.Segmenter(grapheme)；不可用时回退 Array.from（按码点，对代理对仍安全）。
 */
export function truncateGrapheme(str: string, max: number): string {
  if (max <= 0) return '';
  if (str.length <= max) return str; // 每个字素 ≥1 code unit ⇒ 字素数 ≤ code unit 数
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    const seg = new Seg('zh', { granularity: 'grapheme' });
    const out: string[] = [];
    let count = 0;
    for (const { segment } of seg.segment(str)) {
      if (count >= max) break;
      out.push(segment);
      count += 1;
    }
    return out.join('');
  }
  return Array.from(str).slice(0, max).join('');
}

/**
 * 判定字段最终值是否与期望一致（发布前阻断残缺/拼接正文，第二轮 P0）。
 * - input：精确相等。
 * - contenteditable：归一化（折叠空白、去首尾）后相等，容忍 <br>/格式噪声。
 * 返回 null 表示一致；返回字符串表示不一致原因（供阻断发布 + 日志）。
 */
export function fieldValueMismatch(
  expected: string,
  actual: string,
  isContentEditable: boolean,
): string | null {
  if (isContentEditable) {
    // 仅归一明确的 DOM 渲染差异：CRLF→LF、连续空格/制表符折叠为单空格、
    // 去首尾空白；保留语义空格与换行（第三轮 P0：原实现删除全部空白会放过正文空白丢失）。
    const norm = (s: string) =>
      s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/g, '');
    return norm(actual) === norm(expected) ? null : 'contenteditable value mismatch after typing';
  }
  return actual === expected ? null : 'input value mismatch after typing';
}

/**
 * 计算字符串的字素（grapheme）长度，与服务层 truncateGrapheme 保持一致：
 * 优先 Intl.Segmenter(grapheme)，回退 Array.from（按码点，emoji/代理对安全）。
 * 用于工具层/草稿层的长度校验，避免 String.length（UTF-16 code unit）误伤 emoji
 * （第三轮 P1：'19 ASCII + 😀' = 20 字素 / 21 UTF-16 unit，按 length 会误拒）。
 */
export function graphemeLength(str: string): number {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    let count = 0;
    for (const _ of new Seg('zh', { granularity: 'grapheme' }).segment(str)) count += 1;
    return count;
  }
  return Array.from(str).length;
}

/**
 * 按字点数自适应计算逐字输入预算，使合法长正文能在 deadline 内完成且不全文中止
 * （第三轮 P1：原固定 60s 上限会让 1000 字正文稳定抛 AbortError）。
 * - 估算默认节奏下总耗时 = 字数 ×(均延迟 + 修订分摊 + 停顿分摊)。
 * - 若估算超过 CAP_MS，按比例压缩延迟（自适应节奏），把总耗时压到 CAP 附近，
 *   避免长时间占用账户锁。
 * - maxDurationMs 同步缩放（留安全余量），并设硬上限避免无限占用锁。
 * 返回值可直接展开进 typeLikeHuman 选项；账户锁等待应取 maxDurationMs + 余量。
 */
export interface TypingPlanInput {
  minDelay?: number;
  maxDelay?: number;
  reviseGapMin?: number;
  reviseGapMax?: number;
  reviseMax?: number;
  reviseChance?: number;
  pauseChance?: number;
  pauseMin?: number;
  pauseMax?: number;
  defaultMaxDurationMs?: number;
}
export interface TypingPlan {
  minDelay: number;
  maxDelay: number;
  maxDurationMs: number;
}
export function computeTypingPlan(text: string, base: TypingPlanInput = {}): TypingPlan {
  const minDelay = base.minDelay ?? 45;
  const maxDelay = base.maxDelay ?? 170;
  const reviseGapMin = base.reviseGapMin ?? 0;
  const reviseGapMax = base.reviseGapMax ?? 0;
  const reviseMax = base.reviseMax ?? 1;
  const reviseChance = base.reviseChance ?? 0.85;
  const pauseChance = base.pauseChance ?? 0.05;
  const pauseMin = base.pauseMin ?? 350;
  const pauseMax = base.pauseMax ?? 1300;
  const defaultMaxDurationMs = base.defaultMaxDurationMs ?? 60000;

  const n = Array.from(text).length;
  if (n === 0) {
    return { minDelay, maxDelay, maxDurationMs: defaultMaxDurationMs };
  }
  const meanDelay = (minDelay + maxDelay) / 2;
  const meanGap = reviseGapMin > 0 && reviseGapMax > 0 ? (reviseGapMin + reviseGapMax) / 2 : 0;
  // 每次修订回删 reviseMax 字 + 重输 reviseMax 字，按间距均摊到每字
  const reviseOverheadPerChar =
    meanGap > 0
      ? (reviseChance * reviseMax * (meanDelay + (minDelay + maxDelay) / 4)) / meanGap
      : 0;
  const pauseOverheadPerChar = pauseChance * ((pauseMin + pauseMax) / 2);
  const perChar = meanDelay + reviseOverheadPerChar + pauseOverheadPerChar;

  const CAP_MS = 150000; // 2.5min 输入上限，避免长期占用账户锁
  const estMs = n * perChar;
  let planMin = minDelay;
  let planMax = maxDelay;
  let budget = Math.max(defaultMaxDurationMs, Math.ceil(estMs) + 5000);
  if (estMs > CAP_MS) {
    const scale = CAP_MS / estMs; // <1，压缩延迟使总耗时逼近 CAP
    planMin = Math.max(12, Math.round(minDelay * scale));
    planMax = Math.max(planMin + 20, Math.round(maxDelay * scale));
    budget = CAP_MS + 10000;
  }
  budget = Math.min(budget, 240000); // 硬上限 4min，防锁无限占用
  return { minDelay: planMin, maxDelay: planMax, maxDurationMs: budget };
}

/**
 * Generate a random number within a range.
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (exclusive)
 */
function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * 拟人化逐字输入的可选参数。
 */
export interface TypeLikeHumanOptions {
  minDelay?: number;
  maxDelay?: number;
  pauseChance?: number;
  pauseMin?: number;
  pauseMax?: number;
  /**
   * 随机回删的最小间距（码点数）。与 reviseGapMax 一起随机化修订发生位置，
   * 制造"删除/修订"信号且避免固定周期形成机器特征（第二轮 P1）。
   * 0 或省略 = 关闭修订。
   */
  reviseGapMin?: number;
  /**
   * 随机回删的最大间距（码点数）。每次修订机会后重新在
   * [reviseGapMin, reviseGapMax] 间取随机间距，使轨迹非周期。
   */
  reviseGapMax?: number;
  /**
   * 单次修订回删并重输的码点数（默认 1）。
   */
  reviseMax?: number;
  /**
   * 每个修订机会触发的概率门控（默认 0.85），进一步打散节奏。
   */
  reviseChance?: number;
  /**
   * 单次输入允许的最大修订次数（硬上限，防聚类 + 防过长）。
   * 0 或省略 = 自动上限 min(ceil(码点数 * 0.08), 64)。
   */
  maxRevisions?: number;
  /**
   * 软上限：累计输入耗时超过该值（ms）即抛 AbortError 中断（不再静默返回成功），
   * 由上层 finally 释放账户锁并阻断发布。防止长文（1000 字≈149s）无限占用锁。默认 60000。
   */
  maxDurationMs?: number;
  /**
   * 取消信号：aborted 时立即中断并抛出 AbortError。
   * 调用方须在 finally 中释放页面操作与账户锁。
   */
  signal?: AbortSignal;
  /**
   * B5：覆盖全局 `config.antiDetect.typing.mode`。
   * `ime` 当前 wontfix，降级为 direct（见 docs/blue-team/B5-IME.md）。
   */
  mode?: 'direct' | 'ime';
}

/** B5：进程内仅 warn 一次，避免每条评论刷屏 */
let imeWontfixWarned = false;

/**
 * 解析有效键入模式（选项覆盖 config）。
 * `ime` → 返回 `direct` 并可选 warn（composition 为 wontfix）。
 */
export function resolveTypingMode(
  override?: 'direct' | 'ime',
  warn = true,
): 'direct' {
  const requested = override ?? config.antiDetect.typing?.mode ?? 'direct';
  if (requested === 'ime') {
    if (warn && !imeWontfixWarned) {
      imeWontfixWarned = true;
      log.warn(
        'B5 IME composition 为 wontfix：可信 CDP Input 无法模拟真实中文 IME composition 事件流，已降级为 direct（码点 keyboard.type + revise）',
        { requested, see: 'docs/blue-team/B5-IME.md' },
      );
    }
  }
  return 'direct';
}

/** 测试辅助：重置 IME wontfix warn 闸门 */
export function resetImeWontfixWarnGate(): void {
  imeWontfixWarned = false;
}

/**
 * 拟人化逐字输入（A2 / B5）：
 * - 每个字符之间加入可变延迟与偶发长停顿，消除无 delay keyboard.type 的
 *   亚毫秒输入突发（蓝军报告 04 §3.2/§3.3），单字符间隔 CV > 0。
 * - 按码点切分（Array.from），正确处理代理对/emoji。
 * - 偶发"删除/修订"：回删若干字符后重输（可信 Backspace），满足 A2 DoD
 *   的"存在删除/修订"。
 * - B5：`typing.mode=ime` 为书面 wontfix——经可信通道无法模拟 IME composition，
 *   运行时降级 `direct`；DoD 收缩为可测量的"删除/修订 + 间隔方差"。见 B5-IME.md。
 * - 支持取消（AbortSignal）与软上限（maxDurationMs），避免长文阻塞账户锁。
 * 全程走真实键盘通道（isTrusted=true 的可信事件），仅把节奏拟人化。
 */
export async function typeLikeHuman(
  page: Page,
  text: string,
  options?: TypeLikeHumanOptions,
): Promise<void> {
  // B5：解析模式（ime → direct + 一次性 warn）
  resolveTypingMode(options?.mode);

  const minDelay = options?.minDelay ?? 45;
  const maxDelay = options?.maxDelay ?? 170;
  const pauseChance = options?.pauseChance ?? 0.05;
  const pauseMin = options?.pauseMin ?? 350;
  const pauseMax = options?.pauseMax ?? 1300;
  const reviseGapMin = options?.reviseGapMin ?? 0;
  const reviseGapMax = options?.reviseGapMax ?? 0;
  const reviseMax = options?.reviseMax ?? 1;
  const reviseChance = options?.reviseChance ?? 0.85;
  const maxDurationMs = options?.maxDurationMs ?? 60000;
  const signal = options?.signal;

  const chars = Array.from(text); // 按码点切分，正确处理代理对/emoji
  // 修订硬上限：0/省略 → 自动 min(ceil(码点数*0.08), 64)
  const maxRevisions =
    options?.maxRevisions && options.maxRevisions > 0
      ? options.maxRevisions
      : Math.min(Math.ceil(chars.length * 0.08), 64);

  const start = Date.now();
  let i = 0;
  let revisions = 0;
  // 下一个修订机会发生的位置（随机间距，非固定周期）
  let nextReviseAt =
    reviseGapMin > 0
      ? i + Math.floor(randomBetween(reviseGapMin, reviseGapMax + 1))
      : Number.MAX_SAFE_INTEGER;
  while (i < chars.length) {
    if (signal?.aborted) {
      throw new DOMException('typeLikeHuman aborted', 'AbortError');
    }
    if (Date.now() - start > maxDurationMs) {
      // 软上限命中：停止键入，剩余内容不输入（避免长文阻塞账户锁）
      throw new DOMException('typeLikeHuman timeout: maxDurationMs exceeded, input incomplete', 'AbortError');
    }
    await page.keyboard.type(chars[i]);
    await heavyTailDelayBetween(minDelay, maxDelay);
    i += 1;

    // 人类修订：回删若干字符后重输，制造删除/修订信号（可信事件，不引入 isTrusted=false）
    if (i >= nextReviseAt && revisions < maxRevisions && Math.random() < reviseChance) {
      const back = Math.min(i, reviseMax);
      const redo = chars.slice(i - back, i);
      for (let k = 0; k < back; k++) {
        await page.keyboard.press('Backspace');
        await heavyTailDelayBetween(Math.max(10, minDelay / 2), maxDelay / 2);
      }
      for (const ch of redo) {
        await page.keyboard.type(ch);
        await heavyTailDelayBetween(minDelay, maxDelay);
      }
      revisions += 1;
      // 重新随机下一次修订间距
      nextReviseAt = i + Math.floor(randomBetween(reviseGapMin, reviseGapMax + 1));
    }

    if (Math.random() < pauseChance) {
      await heavyTailDelayBetween(pauseMin, pauseMax);
    }
  }
}

/**
 * Easing function - easeInOutQuad.
 * Starts slow, speeds up in the middle, slows down at the end.
 * Simulates realistic scrolling behavior.
 * @param t - Progress value from 0 to 1
 * @returns Eased progress value
 */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Options for human-like scrolling behavior.
 */
export interface HumanScrollOptions {
  /** Minimum scroll distance in pixels (default: 300) */
  minDistance?: number;
  /** Maximum scroll distance in pixels (default: 700) */
  maxDistance?: number;
  /** Minimum delay between scrolls in ms (default: 800) */
  minDelay?: number;
  /** Maximum delay between scrolls in ms (default: 2500) */
  maxDelay?: number;
  /** Probability of scrolling back up (default: 0.1) */
  scrollBackChance?: number;
  /** Probability of mouse movement (default: 0.4) */
  mouseMoveChance?: number;
}

/**
 * Simulate human-like scrolling behavior.
 *
 * Features:
 * - Uses mouse.wheel() for realistic scrolling
 * - Splits scroll into multiple steps with easing
 * - Random distances and delays
 * - Occasional mouse movement and scroll-back
 *
 * @param page - Playwright page instance
 * @param options - Scrolling behavior options
 */
export async function humanScroll(page: Page, options: HumanScrollOptions = {}): Promise<void> {
  const {
    minDistance = 300,
    maxDistance = 700,
    minDelay = 800,
    maxDelay = 2500,
    scrollBackChance = 0.1,
    mouseMoveChance = 0.4,
  } = options;

  // Random total scroll distance
  const totalDistance = randomBetween(minDistance, maxDistance);

  // Split into 5-12 small steps (simulates smooth scrolling)
  const steps = Math.floor(randomBetween(5, 12));

  let _scrolled = 0;

  for (let i = 0; i < steps; i++) {
    // Use easing function to calculate speed factor at current progress
    const progress = (i + 1) / steps;
    const prevProgress = i / steps;
    const easedProgress = easeInOutQuad(progress);
    const prevEasedProgress = easeInOutQuad(prevProgress);

    // Calculate distance for this step
    const stepRatio = easedProgress - prevEasedProgress;
    const stepDistance = totalDistance * stepRatio * (0.8 + Math.random() * 0.4);

    // Execute scroll
    await page.mouse.wheel(0, stepDistance);
    _scrolled += stepDistance;

    // Add small horizontal jitter (more realistic)
    if (Math.random() < 0.3) {
      const jitter = (Math.random() - 0.5) * 10;
      await page.mouse.wheel(jitter, 0);
    }

    // Short pause between steps (20-80ms) — B1 行为重尾
    await heavyTailDelayBetween(20, 80);
  }

  // Random mouse movement (simulates eyes following content)
  if (Math.random() < mouseMoveChance) {
    const x = randomBetween(300, 1200);
    const y = randomBetween(200, 600);
    // Move mouse in multiple steps for natural motion
    await page.mouse.move(x, y, { steps: Math.floor(randomBetween(5, 15)) });
  }

  // Main delay (simulates reading content) — B1 行为重尾
  await heavyTailDelayBetween(minDelay, maxDelay);

  // Occasionally scroll back up (humans review content)
  if (Math.random() < scrollBackChance) {
    const backDistance = randomBetween(30, 120);
    const backSteps = Math.floor(randomBetween(2, 5));

    for (let i = 0; i < backSteps; i++) {
      await page.mouse.wheel(0, -backDistance / backSteps);
      await heavyTailDelayBetween(20, 50);
    }

    // Short pause after scrolling back
    await heavyTailDelayBetween(200, 500);
  }
}

export interface WheelApproachOptions {
  /** 最大 wheel 逼近步数（默认 5） */
  maxWheelSteps?: number;
  /** 视口内边距（默认 60px） */
  viewportMargin?: number;
}

/**
 * B4：wheel 小步逼近目标元素，替代裸 scrollIntoViewIfNeeded。
 * 先用 mouse.wheel 向目标方向滚动；仍不可见时 scrollIntoViewIfNeeded 兜底。
 * headful `viewport: null` 时用 window.innerHeight，勿默认 800 误判可见性。
 */
export async function wheelApproachElement(
  page: Page,
  element: ElementHandle,
  options: WheelApproachOptions = {},
): Promise<void> {
  const maxWheelSteps = options.maxWheelSteps ?? 5;
  const margin = options.viewportMargin ?? 60;
  const vh = await resolvePageViewportHeight(page);

  const isComfortablyVisible = async (): Promise<boolean> => {
    const box = await element.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) return false;
    return box.y >= margin && box.y + box.height <= vh - margin;
  };

  if (await isComfortablyVisible()) return;

  for (let i = 0; i < maxWheelSteps; i++) {
    const box = await element.boundingBox();
    if (!box) break;
    if (box.y >= margin && box.y + box.height <= vh - margin) return;

    const delta =
      box.y < margin
        ? -(120 + Math.random() * 180)
        : 150 + Math.random() * 220;
    await page.mouse.wheel(0, delta);
    await heavyTailDelayBetween(80, 220);
  }

  if (!(await isComfortablyVisible())) {
    await element.scrollIntoViewIfNeeded().catch(() => {});
  }
}

/** Playwright 固定 viewport，或 headful null 时取真实窗口高度 */
async function resolvePageViewportHeight(page: Page): Promise<number> {
  const fixed = page.viewportSize();
  if (fixed?.height && fixed.height > 0) return fixed.height;
  try {
    const h = await page.evaluate(() => window.innerHeight);
    if (typeof h === 'number' && h > 0) return h;
  } catch {
    /* page closed */
  }
  return 800;
}

/**
 * Scroll to the bottom of a page using human-like behavior.
 * Calls humanScroll repeatedly until reaching the bottom.
 *
 * @param page - Playwright page instance
 * @param options - Scrolling options plus maxScrolls limit
 * @returns True if bottom was reached, false if max scrolls exceeded
 */
export async function humanScrollToBottom(
  page: Page,
  options: HumanScrollOptions & { maxScrolls?: number } = {},
): Promise<boolean> {
  const { maxScrolls = 50, ...scrollOptions } = options;

  let previousHeight = 0;
  let sameHeightCount = 0;

  for (let i = 0; i < maxScrolls; i++) {
    // Get current scroll position and page height
    const { scrollTop, scrollHeight, clientHeight } = await evalDom(
      page,
      () => ({
        scrollTop: window.scrollY,
        scrollHeight: document.body.scrollHeight,
        clientHeight: window.innerHeight,
      }),
      null,
    );

    // Check if we've reached the bottom
    if (scrollTop + clientHeight >= scrollHeight - 100) {
      // May have reached bottom, but could be loading more
      if (scrollHeight === previousHeight) {
        sameHeightCount++;
        if (sameHeightCount >= 3) {
          // Height unchanged 3 times in a row - confirmed at bottom
          return true;
        }
      } else {
        sameHeightCount = 0;
      }
    }

    previousHeight = scrollHeight;

    // Perform human-like scroll
    await humanScroll(page, scrollOptions);
  }

  return false;
}

/**
 * 页面不可访问的错误关键词
 */
const PAGE_INACCESSIBLE_KEYWORDS = [
  '当前笔记暂时无法浏览',
  '该内容因违规已被删除',
  '该笔记已被删除',
  '内容不存在',
  '笔记不存在',
  '已失效',
  '私密笔记',
  '仅作者可见',
  '因用户设置，你无法查看',
  '因违规无法查看',
  '你访问的页面不见了',
];

/**
 * 错误容器的选择器
 */
const ERROR_CONTAINER_SELECTORS = '.access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper';

/**
 * 检查页面是否可访问
 * 参考 reference project 的 checkPageAccessible 实现
 *
 * @param page - Playwright page instance
 * @returns null if accessible, error message if not
 */
export async function checkPageAccessible(page: Page): Promise<string | null> {
  await sleep(500);

  // 方法1：检查 URL 是否包含 /404，并解析 error_msg
  const url = page.url();
  if (url.includes('/404')) {
    // 尝试从 URL 解析 error_msg 参数
    try {
      const urlObj = new URL(url);
      const errorMsg = urlObj.searchParams.get('error_msg');
      const errorCode = urlObj.searchParams.get('error_code');
      if (errorMsg) {
        const decodedMsg = decodeURIComponent(errorMsg);
        return `笔记不可访问: ${decodedMsg}${errorCode ? ` (错误码: ${errorCode})` : ''}`;
      }
    } catch {
      // URL 解析失败，使用通用错误消息
    }
    return '页面已跳转到404，笔记不可访问';
  }

  // 方法2：检查页面标题
  const title = await page.title();
  if (title.includes('你访问的页面不见了')) {
    return '笔记不可访问：页面不存在';
  }

  // 方法3：查找错误容器
  const wrapperEl = await page.$(ERROR_CONTAINER_SELECTORS);
  if (!wrapperEl) {
    // 未找到错误容器，页面可访问
    return null;
  }

  // 获取文本内容
  const text = await wrapperEl.textContent();
  if (!text) {
    return null;
  }

  // 检查关键词
  for (const keyword of PAGE_INACCESSIBLE_KEYWORDS) {
    if (text.includes(keyword)) {
      return `笔记不可访问: ${keyword}`;
    }
  }

  // 如果有错误容器但不匹配关键词，返回未知错误
  const trimmedText = text.trim();
  if (trimmedText) {
    return `笔记不可访问: ${trimmedText.substring(0, 100)}`;
  }

  return null;
}

/** B7：导航重试上限（含首次 goto，共 maxRetries 次尝试） */
export const NAVIGATE_RETRY_MAX = 3;

/** B7：导航失败重试间隔默认区间 [min, max] ms */
export const NAVIGATE_RETRY_DELAY_MS: [number, number] = [3000, 5000];

/**
 * B7：采样导航重试间隔 ms。
 * `navRetryHeavyTail.enabled=true` 时用重尾；否则均匀 [min, max]（迁移前行为）。
 */
export function sampleNavRetryDelayMs(
  retryDelay: [number, number] = NAVIGATE_RETRY_DELAY_MS,
): number {
  const lo = Math.max(1, Math.min(retryDelay[0], retryDelay[1]));
  const hi = Math.max(lo, Math.max(retryDelay[0], retryDelay[1]));
  const navCfg = config.antiDetect.navRetryHeavyTail;

  if (navCfg?.enabled !== false) {
    const base = Math.sqrt(lo * hi);
    return sampleHeavyTailMs(base, { minMs: lo, maxMs: hi });
  }

  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

/**
 * 带重试机制的页面导航和访问检测
 * 如果页面不可访问，会重试最多 maxRetries 次
 *
 * @param page - Playwright page instance
 * @param url - 要访问的 URL
 * @param maxRetries - 最大重试次数 (默认 NAVIGATE_RETRY_MAX=3)
 * @param retryDelay - 重试间隔范围 [min, max] 毫秒 (默认 NAVIGATE_RETRY_DELAY_MS)
 * @returns null if accessible, error message if all retries failed
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  maxRetries: number = NAVIGATE_RETRY_MAX,
  retryDelay: [number, number] = NAVIGATE_RETRY_DELAY_MS,
): Promise<string | null> {
  const attempts = Math.max(1, Math.floor(maxRetries));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // 等待 DOM 稳定，最多 3 秒（类似 reference project 的 MustWaitDOMStable）
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await sleep(500);

    const accessError = await checkPageAccessible(page);
    if (!accessError) {
      return null;
    }

    if (attempt === attempts) {
      return `${accessError} (重试 ${attempts} 次后仍然失败)`;
    }

    const delayMs = sampleNavRetryDelayMs(retryDelay);
    log.debug('B7 navigateWithRetry: 重试前等待', { attempt, attempts, delayMs, url });
    await sleep(delayMs);
  }

  return null;
}

/**
 * 检查路径是否为 HTTP/HTTPS URL
 * @param imagePath - 图片路径或 URL
 * @returns 是否为 HTTP URL
 */
export function isHttpUrl(imagePath: string): boolean {
  const lower = imagePath.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

/**
 * 从 URL 下载图片到本地临时目录（C4：经账号 APIRequestContext，对齐 downloadFile）。
 *
 * @param imageUrl - 图片 URL
 * @param apiRequest - 账号浏览器上下文的 APIRequestContext（必填；禁止裸 fetch）
 * @returns 本地文件路径
 * @throws 如果缺少 apiRequest 或下载失败
 */
export async function downloadImageFromUrl(
  imageUrl: string,
  apiRequest: APIRequestContext,
): Promise<string> {
  await fs.ensureDir(paths.tempImages);

  const hash = crypto.createHash('sha256').update(imageUrl).digest('hex');
  const shortHash = hash.substring(0, 16);

  // 同 URL 哈希已存在则复用，避免重复下载
  const existingFiles = await fs.readdir(paths.tempImages);
  const existingFile = existingFiles.find((f) => f.includes(shortHash) && !f.endsWith('.tmp'));
  if (existingFile) {
    return path.join(paths.tempImages, existingFile);
  }

  const timestamp = Date.now();
  const tmpPath = path.join(paths.tempImages, `img_${shortHash}_${timestamp}.tmp`);
  await downloadFile(imageUrl, tmpPath, apiRequest, { resourceType: 'image' });

  const buffer = await fs.readFile(tmpPath);
  const extension = detectImageExtension(buffer);
  if (!extension) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error('下载的文件不是有效的图片格式');
  }

  const filePath = path.join(paths.tempImages, `img_${shortHash}_${timestamp}.${extension}`);
  await fs.rename(tmpPath, filePath);
  return filePath;
}

/**
 * 通过文件魔数检测图片格式
 * @param buffer - 文件内容
 * @returns 文件扩展名，如果不是图片则返回 null
 */
function detectImageExtension(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }

  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'gif';
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }

  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'bmp';
  }

  return null;
}

/**
 * 处理图片路径列表，将 HTTP URL 经账号会话下载到本地。
 *
 * C4：含 HTTP URL 时必须提供 apiRequest，禁止 Node 裸 fetch 旁路 egress。
 *
 * @param imagePaths - 图片路径或 URL 列表
 * @param apiRequest - 账号 APIRequestContext；有 HTTP URL 时必填
 * @returns 本地文件路径列表
 */
export async function resolveImagePaths(
  imagePaths: string[],
  apiRequest?: APIRequestContext | null,
): Promise<string[]> {
  const resolvedPaths: string[] = [];
  const hasHttp = imagePaths.some((p) => isHttpUrl(p));
  if (hasHttp && !apiRequest) {
    throw new Error(
      'HTTP 配图下载需要账号 APIRequestContext（禁止 Node 裸 fetch 旁路）。请先 ensureContext 再 resolveImagePaths。',
    );
  }

  for (const imgPath of imagePaths) {
    if (isHttpUrl(imgPath)) {
      const localPath = await downloadImageFromUrl(imgPath, apiRequest!);
      resolvedPaths.push(localPath);
    } else {
      resolvedPaths.push(imgPath);
    }
  }

  return resolvedPaths;
}

export {
  evalMainState,
  evalDom,
  waitForMainState,
  waitForDom,
  waitForInitialState,
  isFatalPageEvalError,
  type WaitForMainStateOptions,
} from './page-eval.js';
