/**
 * @fileoverview B3 Interact 会话化：入页阅读 dwell + 阅读滚动 + 动作后停留。
 * @module xhs/utils/interact-session
 */

import type { Page } from 'patchright';
import { config } from '../../core/config.js';
import type { InteractSessionMeta } from '../types.js';
import type { InteractEntry } from './interact-entry.js';
import { humanScroll, sampleHeavyTailMs, sleep } from './index.js';

/** B3 批处理等场景可保留页面不关；D1 可选有机点入 */
export interface InteractSessionOpts {
  keepPage?: boolean;
  /** D1：进帖入口；缺省读 config.antiDetect.interactEntry.default（默认 direct） */
  entry?: InteractEntry;
}

export type { InteractSessionMeta, InteractEntry };

let lastInteractSessionMeta: InteractSessionMeta | null = null;

export function getLastInteractSessionMeta(): InteractSessionMeta | null {
  return lastInteractSessionMeta;
}

/** 测试辅助：重置最近一次会话 meta */
export function resetLastInteractSessionMeta(): void {
  lastInteractSessionMeta = null;
}

export function recordInteractSessionMeta(meta: InteractSessionMeta): InteractSessionMeta {
  lastInteractSessionMeta = meta;
  return meta;
}

/**
 * 入页后阅读阶段：重尾 dwell + ≥ minReadScrolls 次 humanScroll（wheel）。
 * `interactSession.enabled=false` 时空操作。
 */
export async function runInteractReadingPhase(page: Page): Promise<{
  enabled: boolean;
  preDwellMs: number;
  readScrollCount: number;
}> {
  const cfg = config.antiDetect.interactSession;
  if (!cfg?.enabled) {
    return { enabled: false, preDwellMs: 0, readScrollCount: 0 };
  }

  const preBase = Math.max(1, cfg.preDwellMs);
  const preMin = Math.max(1, Math.round(preBase * 0.5));
  const preMax = Math.max(preMin, Math.round(preBase * 2.5));
  const preDwellMs = sampleHeavyTailMs(preBase, { minMs: preMin, maxMs: preMax });
  await sleep(preDwellMs);

  const minScrolls = Math.max(1, cfg.minReadScrolls ?? 1);
  // 约 35% 再多滚一次，避免永远刚好 1 次
  const readScrollCount = minScrolls + (Math.random() < 0.35 ? 1 : 0);
  for (let i = 0; i < readScrollCount; i++) {
    await humanScroll(page, {
      minDistance: 180,
      maxDistance: 420,
      minDelay: 300,
      maxDelay: 900,
      scrollBackChance: 0.12,
      mouseMoveChance: 0.35,
    });
  }

  return { enabled: true, preDwellMs, readScrollCount };
}

export interface InteractPostStayOptions {
  /** B7：alreadyDone 路径使用短 post-stay，避免完整探测会话指纹 */
  shortSession?: boolean;
}

/**
 * 动作后停留（重尾）。关闭会话化时返回 0（由调用方决定是否走短 B1 dwell）。
 * `shortSession=true` 且 `alreadyDoneShort.enabled` 时用更短 dwell 并标记 skippedAlreadyDone。
 */
export async function runInteractPostStay(
  options: InteractPostStayOptions = {},
): Promise<{
  enabled: boolean;
  postStayMs: number;
  skippedAlreadyDone?: boolean;
}> {
  const cfg = config.antiDetect.interactSession;
  if (!cfg?.enabled) {
    return { enabled: false, postStayMs: 0 };
  }

  const shortCfg = config.antiDetect.alreadyDoneShort;
  if (options.shortSession && shortCfg?.enabled) {
    const postBase = Math.max(1, shortCfg.postStayMs);
    const postMin = Math.max(1, Math.round(postBase * 0.5));
    const postMax = Math.max(postMin, Math.round(postBase * 1.5));
    const postStayMs = sampleHeavyTailMs(postBase, { minMs: postMin, maxMs: postMax });
    await sleep(postStayMs);
    return { enabled: true, postStayMs, skippedAlreadyDone: true };
  }

  const postBase = Math.max(1, cfg.postStayMs);
  const postMin = Math.max(1, Math.round(postBase * 0.5));
  const postMax = Math.max(postMin, Math.round(postBase * 2.5));
  const postStayMs = sampleHeavyTailMs(postBase, { minMs: postMin, maxMs: postMax });
  await sleep(postStayMs);
  return { enabled: true, postStayMs, skippedAlreadyDone: false };
}

/** 组装并记录会话 meta */
export function finalizeInteractSessionMeta(parts: {
  enabled: boolean;
  preDwellMs: number;
  readScrollCount: number;
  postStayMs: number;
  trajectorySteps: number | null;
  keepPage: boolean;
  skippedAlreadyDone?: boolean;
  entry?: InteractEntry;
  entryFallback?: boolean;
}): InteractSessionMeta {
  return recordInteractSessionMeta({
    enabled: parts.enabled,
    preDwellMs: parts.preDwellMs,
    readScrollCount: parts.readScrollCount,
    postStayMs: parts.postStayMs,
    trajectorySteps: parts.trajectorySteps,
    keepPage: parts.keepPage,
    skippedAlreadyDone: parts.skippedAlreadyDone,
    entry: parts.entry,
    entryFallback: parts.entryFallback,
  });
}
