/**
 * @fileoverview B3 Interact 会话化：入页阅读 dwell + 阅读滚动 + 动作后停留。
 * @module xhs/utils/interact-session
 */

import type { Page } from 'patchright';
import { config } from '../../core/config.js';
import type { InteractSessionMeta } from '../types.js';
import { humanScroll, sampleHeavyTailMs, sleep } from './index.js';

/** 批处理等场景可保留页面不关 */
export interface InteractSessionOpts {
  keepPage?: boolean;
}

export type { InteractSessionMeta };

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

/**
 * 动作后停留（重尾）。关闭会话化时返回 0（由调用方决定是否走短 B1 dwell）。
 */
export async function runInteractPostStay(): Promise<{
  enabled: boolean;
  postStayMs: number;
}> {
  const cfg = config.antiDetect.interactSession;
  if (!cfg?.enabled) {
    return { enabled: false, postStayMs: 0 };
  }

  const postBase = Math.max(1, cfg.postStayMs);
  const postMin = Math.max(1, Math.round(postBase * 0.5));
  const postMax = Math.max(postMin, Math.round(postBase * 2.5));
  const postStayMs = sampleHeavyTailMs(postBase, { minMs: postMin, maxMs: postMax });
  await sleep(postStayMs);
  return { enabled: true, postStayMs };
}

/** 组装并记录会话 meta */
export function finalizeInteractSessionMeta(parts: {
  enabled: boolean;
  preDwellMs: number;
  readScrollCount: number;
  postStayMs: number;
  trajectorySteps: number | null;
  keepPage: boolean;
}): InteractSessionMeta {
  return recordInteractSessionMeta({
    enabled: parts.enabled,
    preDwellMs: parts.preDwellMs,
    readScrollCount: parts.readScrollCount,
    postStayMs: parts.postStayMs,
    trajectorySteps: parts.trajectorySteps,
    keepPage: parts.keepPage,
  });
}
