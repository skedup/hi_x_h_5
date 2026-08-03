/**
 * @fileoverview D1：feed 有机点入 / 回退单测（mock page，不依赖真站）。
 * @module xhs/utils/interact-entry.test
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  openNoteForInteract,
  resolveInteractEntry,
  tryOpenNoteFromFeed,
} from './interact-entry.js';

describe('resolveInteractEntry', () => {
  it('单次参数优先', () => {
    expect(resolveInteractEntry('feed')).toBe('feed');
    expect(resolveInteractEntry('direct')).toBe('direct');
  });

  it('缺省为 direct', () => {
    expect(resolveInteractEntry(undefined)).toBe('direct');
  });
});

function makePage(opts: { cover?: any; modal?: any; url?: string } = {}) {
  return {
    goto: mock(async () => {}),
    waitForLoadState: mock(async () => {}),
    waitForSelector: mock(async () => opts.modal ?? null),
    $: mock(async (sel: string) => (sel.includes('href*=') ? opts.cover ?? null : null)),
    url: () => opts.url ?? 'https://www.xiaohongshu.com/explore',
    mouse: {
      move: mock(async () => {}),
      down: mock(async () => {}),
      up: mock(async () => {}),
      wheel: mock(async () => {}),
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
    evaluate: mock(async () => undefined),
    locator: mock(() => ({
      boundingBox: mock(async () => ({ x: 10, y: 10, width: 100, height: 100 })),
    })),
  } as any;
}

describe('openNoteForInteract', () => {
  it('feed 找不到封面时回退 direct 并标记 entryFallback', async () => {
    const page = makePage();
    const directOpen = mock(async () => undefined);
    const r = await openNoteForInteract(page, 'nid', 'tok', 'feed', {
      maxScrolls: 2,
      skipWarmup: true,
      directOpen,
    });
    expect(r.entryFallback).toBe(true);
    expect(r.mode).toBe('direct');
    expect(directOpen).toHaveBeenCalled();
  });

  it('feed 封面可见时走轨迹点击且不回退', async () => {
    const cover = {
      boundingBox: mock(async () => ({ x: 20, y: 40, width: 120, height: 160 })),
      click: mock(async () => {}),
      evaluate: mock(async () => ({})),
      scrollIntoViewIfNeeded: mock(async () => {}),
    };
    const page = makePage({
      cover,
      modal: { ok: true },
      url: 'https://www.xiaohongshu.com/explore',
    });
    // ElementHandle-like：page.$ 返回的 cover 需支持轨迹点击所需 API
    const directOpen = mock(async () => undefined);
    const r = await openNoteForInteract(page, 'nid', 'tok', 'feed', {
      maxScrolls: 1,
      skipWarmup: true,
      directOpen,
    });
    expect(r.mode).toBe('feed');
    expect(r.entryFallback).toBe(false);
    expect(directOpen).not.toHaveBeenCalled();
  });

  it('direct 不标记 fallback', async () => {
    const page = makePage();
    const directOpen = mock(async () => undefined);
    const r = await openNoteForInteract(page, 'nid', 'tok', 'direct', { directOpen });
    expect(r.mode).toBe('direct');
    expect(r.entryFallback).toBe(false);
    expect(directOpen).toHaveBeenCalled();
  });
});

describe('tryOpenNoteFromFeed', () => {
  it('找不到封面返回 false', async () => {
    const page = makePage();
    const ok = await tryOpenNoteFromFeed(page, 'missing', { maxScrolls: 1, skipWarmup: true });
    expect(ok).toBe(false);
  });
});
