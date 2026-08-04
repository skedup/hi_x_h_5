/**
 * @fileoverview D1：Interact 进帖入口 — direct 直链 vs feed 有机点入。
 * @module xhs/utils/interact-entry
 */

import type { ElementHandle, Page } from 'patchright';
import { createLogger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { EXPLORE_SELECTORS } from '../clients/constants.js';
import {
  navigateWithRetry,
  clickWithTrajectory,
  humanScroll,
  wheelApproachElement,
  heavyTailDelay,
  waitForInitialState,
} from './index.js';
import { evalMainState } from './page-eval.js';

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
 * 从 URL / href 解析笔记 ID（精确 path 段，非子串）。
 */
export function extractNoteIdFromPath(urlOrPath: string): string | null {
  try {
    const u = urlOrPath.includes('://')
      ? new URL(urlOrPath)
      : new URL(urlOrPath, 'https://www.xiaohongshu.com');
    const m = u.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/);
    return m?.[1] ?? null;
  } catch {
    const m = urlOrPath.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/);
    return m?.[1] ?? null;
  }
}

function resolveAbsoluteHref(href: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `https://www.xiaohongshu.com${href}`;
  return `https://www.xiaohongshu.com/${href}`;
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
  return navigateWithRetry(page, buildNoteUrl(noteId, xsecToken)) ?? undefined;
}

/**
 * 校验当前页（详情或 modal）打开的笔记是否为目标 noteId。
 */
export async function verifyOpenedNoteId(page: Page, noteId: string): Promise<boolean> {
  if (extractNoteIdFromPath(page.url()) === noteId) return true;

  const fromState = await evalMainState(
    page,
    (id) => {
      const state = (window as any).__INITIAL_STATE__;
      let map = state?.note?.noteDetailMap;
      if (!map) return false;
      map = map.value !== undefined ? map.value : map._value || map;
      if (!map || typeof map !== 'object') return false;
      if (map[id]) return true;
      return Object.keys(map).some((k) => k === id);
    },
    noteId,
  ).catch(() => false);

  return !!fromState;
}

/**
 * 在封面列表中按 path 段精确匹配 noteId（避免 href*= 子串误匹配）。
 */
export async function findExactNoteCover(
  page: Page,
  noteId: string,
): Promise<{ cover: ElementHandle; href: string } | null> {
  const covers = await page.$$(EXPLORE_SELECTORS.noteCover);
  for (const cover of covers) {
    const href = (await cover.getAttribute('href')) || '';
    if (extractNoteIdFromPath(href) === noteId) {
      return { cover, href };
    }
  }
  return null;
}

/**
 * 在 explore 首页滚动查找封面并轨迹点击进入。
 * 若落在 modal，再经封面原始 href 落到详情页，保证 Interact 选择器可用。
 * @returns true 若成功打开且身份校验通过
 */
export async function tryOpenNoteFromFeed(
  page: Page,
  noteId: string,
  options: { maxScrolls?: number; skipWarmup?: boolean } = {},
): Promise<boolean> {
  const maxScrolls = options.maxScrolls ?? 8;

  await page.goto('https://www.xiaohongshu.com/explore', {
    waitUntil: 'domcontentloaded',
  });
  if (!options.skipWarmup) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await waitForInitialState(page, { timeout: 15000 }).catch(() => {});
  }

  for (let i = 0; i < maxScrolls; i++) {
    const found = await findExactNoteCover(page, noteId);
    if (found) {
      const { cover, href } = found;
      await wheelApproachElement(page, cover);
      await heavyTailDelay(300, { minMs: 180, maxMs: 420 });
      await clickWithTrajectory(page, cover, { allowForceFallback: true });
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });

      const modal = await page
        .waitForSelector(EXPLORE_SELECTORS.noteContainer, { timeout: 5000 })
        .catch(() => null);
      const urlMatched = extractNoteIdFromPath(page.url()) === noteId;

      if (!modal && !urlMatched) {
        log.warn('D1 feed 点击后未检测到详情', { noteId });
        return false;
      }

      // 已在详情 URL：校验后返回
      if (urlMatched) {
        if (!(await verifyOpenedNoteId(page, noteId))) {
          log.warn('D1 feed 打开后 noteId 校验失败', { noteId, url: page.url() });
          return false;
        }
        return true;
      }

      // Modal 叠在 explore 首页：封面已精确匹配 noteId，经封面原始 href 落详情后再校验 URL
      const abs = resolveAbsoluteHref(href);
      log.info('D1 feed modal 落详情页', { noteId, href: abs.slice(0, 80) });
      await page.goto(abs, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      if (!(await verifyOpenedNoteId(page, noteId))) {
        log.warn('D1 feed 落详情后 noteId 校验失败', { noteId, url: page.url() });
        return false;
      }

      return true;
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

  const finishDirect = async (
    mode: InteractEntry,
    entryFallback: boolean,
  ): Promise<OpenNoteForInteractResult> => {
    const error = await runDirect(page, noteId, xsecToken);
    if (error) return { mode, entryFallback, error };
    if (!(await verifyOpenedNoteId(page, noteId))) {
      return { mode, entryFallback, error: 'opened_note_id_mismatch' };
    }
    return { mode, entryFallback };
  };

  if (entry === 'direct') {
    return finishDirect('direct', false);
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
  return finishDirect('direct', true);
}

/** @internal 测试用 */
export { buildNoteUrl };
