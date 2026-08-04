/**
 * @fileoverview D1：feed 有机点入 / 回退单测（mock page，不依赖真站）。
 * @module xhs/utils/interact-entry.test
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  extractNoteIdFromPath,
  openNoteForInteract,
  resolveInteractEntry,
  tryOpenNoteFromFeed,
  verifyOpenedNoteId,
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

describe('extractNoteIdFromPath', () => {
  it('精确解析 path 段', () => {
    expect(extractNoteIdFromPath('https://www.xiaohongshu.com/explore/abc123')).toBe('abc123');
    expect(extractNoteIdFromPath('/explore/abc123?xsec_token=x')).toBe('abc123');
    expect(extractNoteIdFromPath('/discovery/item/abc123')).toBe('abc123');
  });

  it('不把子串当 id', () => {
    expect(extractNoteIdFromPath('/explore/abc123extra')).toBe('abc123extra');
    expect(extractNoteIdFromPath('/explore/abc123extra')).not.toBe('abc123');
  });
});

function makeCover(href: string) {
  return {
    getAttribute: mock(async (name: string) => (name === 'href' ? href : null)),
    boundingBox: mock(async () => ({ x: 20, y: 40, width: 120, height: 160 })),
    click: mock(async () => {}),
    evaluate: mock(async () => ({})),
    scrollIntoViewIfNeeded: mock(async () => {}),
  };
}

function makePage(opts: {
  covers?: any[];
  modal?: any;
  url?: string;
} = {}) {
  const state = { url: opts.url ?? 'https://www.xiaohongshu.com/explore' };
  return {
    goto: mock(async (u: string) => {
      state.url = u;
    }),
    waitForLoadState: mock(async () => {}),
    waitForSelector: mock(async () => opts.modal ?? null),
    $$: mock(async () => opts.covers ?? []),
    $: mock(async () => null),
    url: () => state.url,
    mouse: {
      move: mock(async () => {}),
      down: mock(async () => {}),
      up: mock(async () => {}),
      wheel: mock(async () => {}),
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
    // evalMainState → page.evaluate(fn, arg, false)
    evaluate: mock(async (fn: any, arg?: any) => {
      if (typeof fn === 'function') {
        try {
          return await fn(arg);
        } catch {
          return false;
        }
      }
      return undefined;
    }),
    locator: mock(() => ({
      boundingBox: mock(async () => ({ x: 10, y: 10, width: 100, height: 100 })),
    })),
  } as any;
}

describe('openNoteForInteract', () => {
  it('feed 找不到封面时回退 direct 并标记 entryFallback', async () => {
    const page = makePage();
    const directOpen = mock(async (_p: any, noteId: string) => {
      await page.goto(`https://www.xiaohongshu.com/explore/${noteId}`);
      return undefined;
    });
    const r = await openNoteForInteract(page, 'nid', 'tok', 'feed', {
      maxScrolls: 1,
      skipWarmup: true,
      directOpen,
    });
    expect(r.entryFallback).toBe(true);
    expect(r.mode).toBe('direct');
    expect(directOpen).toHaveBeenCalled();
  });

  it('feed 精确封面可见时走点入且不回退；modal 经封面 href 落详情', async () => {
    const cover = makeCover('/explore/nid?xsec_token=tok');
    const page = makePage({
      covers: [cover],
      modal: { ok: true },
      url: 'https://www.xiaohongshu.com/explore',
    });
    const directOpen = mock(async () => undefined);
    const r = await openNoteForInteract(page, 'nid', 'tok', 'feed', {
      maxScrolls: 1,
      skipWarmup: true,
      directOpen,
    });
    expect(r.mode).toBe('feed');
    expect(r.entryFallback).toBe(false);
    expect(directOpen).not.toHaveBeenCalled();
    expect(page.url()).toContain('/explore/nid');
  });

  it('feed 子串误匹配封面时回退 direct', async () => {
    // href id 为 nidEXTRA，请求 nid → 不应命中
    const cover = makeCover('/explore/nidEXTRA?xsec_token=tok');
    const page = makePage({
      covers: [cover],
      modal: { ok: true },
      url: 'https://www.xiaohongshu.com/explore',
    });
    const directOpen = mock(async (_p: any, noteId: string) => {
      await page.goto(`https://www.xiaohongshu.com/explore/${noteId}`);
      return undefined;
    });
    const r = await openNoteForInteract(page, 'nid', 'tok', 'feed', {
      maxScrolls: 1,
      skipWarmup: true,
      directOpen,
    });
    expect(r.entryFallback).toBe(true);
    expect(r.mode).toBe('direct');
  });

  it('direct 不标记 fallback 且校验 noteId', async () => {
    const page = makePage();
    const directOpen = mock(async (_p: any, noteId: string) => {
      await page.goto(`https://www.xiaohongshu.com/explore/${noteId}`);
      return undefined;
    });
    const r = await openNoteForInteract(page, 'nid', 'tok', 'direct', { directOpen });
    expect(r.mode).toBe('direct');
    expect(r.entryFallback).toBe(false);
    expect(r.error).toBeUndefined();
    expect(directOpen).toHaveBeenCalled();
  });

  it('direct 打开后 noteId 不匹配则报错', async () => {
    const page = makePage({ url: 'https://www.xiaohongshu.com/explore/other' });
    const directOpen = mock(async () => undefined); // 不改 URL
    const r = await openNoteForInteract(page, 'nid', 'tok', 'direct', { directOpen });
    expect(r.error).toBe('opened_note_id_mismatch');
  });
});

describe('tryOpenNoteFromFeed', () => {
  it('找不到封面返回 false', async () => {
    const page = makePage();
    const ok = await tryOpenNoteFromFeed(page, 'missing', { maxScrolls: 1, skipWarmup: true });
    expect(ok).toBe(false);
  });
});

describe('verifyOpenedNoteId', () => {
  it('URL 精确匹配通过', async () => {
    const page = makePage({ url: 'https://www.xiaohongshu.com/explore/nid' });
    expect(await verifyOpenedNoteId(page, 'nid')).toBe(true);
    expect(await verifyOpenedNoteId(page, 'other')).toBe(false);
  });
});
