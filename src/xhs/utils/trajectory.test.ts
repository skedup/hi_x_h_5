/**
 * @fileoverview B2 指针轨迹点击单测。
 * @module xhs/utils/trajectory.test
 */
import '../../core/logger.js';
import { describe, it, expect, afterAll, beforeEach } from 'bun:test';
import { config } from '../../core/config.js';
import { clickWithTrajectory, getLastTrajectoryMeta } from './index.js';
import type { Page } from 'patchright';

const cfg = config as any;

function makeMockPage(opts?: {
  failDown?: boolean;
}): Page & { moves: Array<{ x: number; y: number }>; clicks: number } {
  const moves: Array<{ x: number; y: number }> = [];
  let clicks = 0;
  const mouse = {
    move: async (x: number, y: number) => {
      moves.push({ x, y });
    },
    down: async () => {
      if (opts?.failDown) throw new Error('mouse down failed');
      clicks += 1;
    },
    up: async () => {},
    click: async (x: number, y: number) => {
      moves.push({ x, y });
      clicks += 1;
    },
  };
  const page = {
    moves,
    get clicks() {
      return clicks;
    },
    mouse,
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  return page as unknown as Page & { moves: Array<{ x: number; y: number }>; clicks: number };
}

function makeHandle(
  box: { x: number; y: number; width: number; height: number } | null,
  opts?: { hit?: boolean | null },
) {
  let forceClicks = 0;
  let normalClicks = 0;
  let scrolled = 0;
  const hit = opts?.hit === undefined ? true : opts.hit;
  return {
    boundingBox: async () => box,
    scrollIntoViewIfNeeded: async () => {
      scrolled += 1;
    },
    evaluate: async () => hit,
    click: async (clickOpts?: { force?: boolean }) => {
      if (clickOpts?.force) forceClicks += 1;
      else normalClicks += 1;
    },
    get forceClicks() {
      return forceClicks;
    },
    get normalClicks() {
      return normalClicks;
    },
    get scrolled() {
      return scrolled;
    },
  };
}

describe('B2 clickWithTrajectory', () => {
  const prev = { ...cfg.antiDetect.trajectory };
  const prevHt = { ...cfg.antiDetect.heavyTail };

  beforeEach(() => {
    cfg.antiDetect.trajectory = { enabled: true, minSteps: 5 };
    // 加速测试：关闭重尾，短均匀等待
    cfg.antiDetect.heavyTail = { enabled: false, sigma: 0.45, maxMultiplier: 8 };
  });

  afterAll(() => {
    cfg.antiDetect.trajectory = prev;
    cfg.antiDetect.heavyTail = prevHt;
  });

  it('启用时 steps ≥ minSteps 且 getLastTrajectoryMeta 可观测', async () => {
    const page = makeMockPage();
    const handle = makeHandle({ x: 200, y: 300, width: 80, height: 40 });
    const meta = await clickWithTrajectory(page, handle as any, { steps: 3 });
    expect(meta.disabled).toBe(false);
    expect(meta.usedForce).toBe(false);
    expect(meta.steps).toBeGreaterThanOrEqual(5);
    expect(page.moves.length).toBe(meta.steps);
    expect(page.clicks).toBe(1);
    expect(handle.scrolled).toBe(1);
    const last = getLastTrajectoryMeta();
    expect(last?.steps).toBe(meta.steps);
    expect(last?.to.x).toBeGreaterThan(200);
    expect(last?.to.x).toBeLessThan(280);
  });

  it('关闭时坐标目标直点，meta.disabled=true', async () => {
    cfg.antiDetect.trajectory = { enabled: false, minSteps: 5 };
    const page = makeMockPage();
    const meta = await clickWithTrajectory(page, { x: 400, y: 50 });
    expect(meta.disabled).toBe(true);
    expect(meta.steps).toBe(1);
    expect(page.clicks).toBe(1);
    expect(page.moves[0]).toEqual({ x: 400, y: 50 });
  });

  it('关闭时元素走 Playwright click（含 scroll）', async () => {
    cfg.antiDetect.trajectory = { enabled: false, minSteps: 5 };
    const page = makeMockPage();
    const handle = makeHandle({ x: 10, y: 10, width: 20, height: 20 });
    const meta = await clickWithTrajectory(page, handle as any);
    expect(meta.disabled).toBe(true);
    expect(handle.scrolled).toBe(1);
    expect(handle.normalClicks).toBe(1);
    expect(page.clicks).toBe(0);
  });

  it('无 boundingBox 且 allowForceFallback 时 force+warn', async () => {
    const page = makeMockPage();
    const handle = makeHandle(null);
    const meta = await clickWithTrajectory(page, handle as any, { allowForceFallback: true });
    expect(meta.usedForce).toBe(true);
    expect(handle.forceClicks).toBe(1);
    expect(handle.scrolled).toBe(1);
  });

  it('无 boundingBox 且不允许 force 时抛错', async () => {
    const page = makeMockPage();
    const handle = makeHandle(null);
    await expect(clickWithTrajectory(page, handle as any)).rejects.toThrow(/no bounding box/);
  });

  it('坐标目标走轨迹点击（替换遮罩常量坐标）', async () => {
    const page = makeMockPage();
    const meta = await clickWithTrajectory(page, { x: 400, y: 50 });
    expect(meta.steps).toBeGreaterThanOrEqual(5);
    expect(meta.to).toEqual({ x: 400, y: 50 });
    expect(page.clicks).toBe(1);
  });

  it('落点被遮罩且 allowForceFallback 时在 mouse down 前 force', async () => {
    const page = makeMockPage();
    const handle = makeHandle({ x: 100, y: 100, width: 50, height: 50 }, { hit: false });
    const meta = await clickWithTrajectory(page, handle as any, { allowForceFallback: true });
    expect(meta.usedForce).toBe(true);
    expect(handle.forceClicks).toBe(1);
    expect(page.clicks).toBe(0); // 未 mouse down，避免点到遮罩
    expect(meta.steps).toBeGreaterThanOrEqual(5); // 轨迹仍走完
  });

  it('落点被遮罩但未开 allowForceFallback 时仍 mouse 点击', async () => {
    const page = makeMockPage();
    const handle = makeHandle({ x: 100, y: 100, width: 50, height: 50 }, { hit: false });
    const meta = await clickWithTrajectory(page, handle as any);
    expect(meta.usedForce).toBe(false);
    expect(handle.forceClicks).toBe(0);
    expect(page.clicks).toBe(1);
  });
});
