/**
 * @fileoverview D1：Interact 进帖入口 — direct 直链 vs feed 有机点入。
 * @module xhs/utils/interact-entry
 */

import type { Page } from 'patchright';
import { config } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { EXPLORE_SELECTORS } from '../clients/constants.js';
import {
  navigateWithRetry,
  clickWithTrajectory,
  humanScroll,
  wheelApproachElement,
  heavyTailDelay,
  waitForInitialState,
} from './index.js';

const log = createLogger('interact-entry');

export type InteractEntry = 'feed' | 'direct';

export interface OpenNoteForInteractResult {
  /** 实际使用的入口（回退后可能变成 direct） */
  mode: InteractEntry;
  /** feed 失败后是否回退到了直链 */
  entryFallback: boolean;
  /** 打开失败时的错误（含回退后仍失败） */
  error?: string;
}

function buildNoteUrl(noteId: string, xsecToken: string): string {
  let url = `https://www.xiaohongshu.com/explore/${noteId}`;
  if (xsecToken) {
    url += `?xsec_token=${encodeURIComponent(xsecToken)}`;
  }
  return url;
}

/**
 * 解析进帖入口：单次参数优先，否则读全局默认（env），缺省 direct。
 */
export function resolveInteractEntry(override?: InteractEntry): InteractEntry {
  if (override === 'feed' || override === 'direct') return override;
  const d = config.antiDetect.interactEntry?.default;
  return d === 'feed' ? 'feed' : 'direct';
}

async function openViaDirect(
  page: Page,
  noteId: string,
  xsecToken: string,
): Promise<string | undefined> {
  return navigateWithRetry(page, buildNoteUrl(noteId, xsecToken));
}

/**
 * 在 explore 首页滚动查找封面并轨迹点击进入（modal 或导航）。
 * @returns true 若成功点开
 */
export async function tryOpenNoteFromFeed(
  page: Page,
  noteId: string,
  options: { maxScrolls?: number; skipWarmup?: boolean } = {},
): Promise<boolean> {
  const maxScrolls = options.maxScrolls ?? 8;
  const coverSelector = `${EXPLORE_SELECTORS.noteCover}[href*="${noteId}"]`;

  await page.goto('https://www.xiaohongshu.com/explore', {
    waitUntil: 'domcontentloaded',
  });
  if (!options.skipWarmup) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await waitForInitialState(page, { timeout: 15000 }).catch(() => {});
  }

  for (let i = 0; i < maxScrolls; i++) {
    const cover = await page.$(coverSelector);
    if (cover) {
      await wheelApproachElement(page, cover);
      await heavyTailDelay(300, { minMs: 180, maxMs: 420 });
      await clickWithTrajectory(page, cover, { allowForceFallback: true });
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
      // modal 或整页详情均可；有 note 容器或 URL 含 noteId 即视为成功
      const modal = await page.waitForSelector(EXPLORE_SELECTORS.noteContainer, { timeout: 5000 }).catch(() => null);
      if (modal) return true;
      if (page.url().includes(noteId)) return true;
      log.warn('D1 feed 点击后未检测到详情', { noteId });
      return false;
    }
    await humanScroll(page, { minDistance: 500, maxDistance: 1000 });
    await heavyTailDelay(400, { minMs: 250, maxMs: 600 });
  }
  return false;
}

/**
 * D1：按 entry 打开笔记。feed 找不到封面时回退 direct 并标记 entryFallback。
 */
export async function openNoteForInteract(
  page: Page,
  noteId: string,
  xsecToken: string,
  entry: InteractEntry,
  options: {
    maxScrolls?: number;
    skipWarmup?: boolean;
    /**
     * @internal 单测注入：替代 navigateWithRetry 直链打开
     */
    directOpen?: (page: Page, noteId: string, xsecToken: string) => Promise<string | undefined>;
  } = {},
): Promise<OpenNoteForInteractResult> {
  const runDirect = options.directOpen ?? openViaDirect;

  if (entry === 'direct') {
    const error = await runDirect(page, noteId, xsecToken);
    return { mode: 'direct', entryFallback: false, ...(error ? { error } : {}) };
  }

  try {
    const opened = await tryOpenNoteFromFeed(page, noteId, {
      maxScrolls: options.maxScrolls,
      skipWarmup: options.skipWarmup,
    });
    if (opened) {
      return { mode: 'feed', entryFallback: false };
    }
  } catch (err) {
    log.warn('D1 feed_entry 异常，回退 direct', {
      noteId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.warn('feed_entry_fallback', { noteId, reason: 'cover_not_found_or_click_failed' });
  const error = await runDirect(page, noteId, xsecToken);
  return {
    mode: 'direct',
    entryFallback: true,
    ...(error ? { error } : {}),
  };
}

/** @internal 测试用 */
export { buildNoteUrl };
