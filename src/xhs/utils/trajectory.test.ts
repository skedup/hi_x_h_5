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

function makeHandle(box: { x: number; y: number; width: number; height: number } | null) {
  let forceClicks = 0;
  return {
    boundingBox: async () => box,
    click: async (opts?: { force?: boolean }) => {
      if (opts?.force) forceClicks += 1;
    },
    get forceClicks() {
      return forceClicks;
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
    const last = getLastTrajectoryMeta();
    expect(last?.steps).toBe(meta.steps);
    expect(last?.to.x).toBeGreaterThan(200);
    expect(last?.to.x).toBeLessThan(280);
  });

  it('关闭时直点，meta.disabled=true', async () => {
    cfg.antiDetect.trajectory = { enabled: false, minSteps: 5 };
    const page = makeMockPage();
    const meta = await clickWithTrajectory(page, { x: 400, y: 50 });
    expect(meta.disabled).toBe(true);
    expect(meta.steps).toBe(1);
    expect(page.clicks).toBe(1);
    expect(page.moves[0]).toEqual({ x: 400, y: 50 });
  });

  it('无 boundingBox 且 allowForceFallback 时 force+warn', async () => {
    const page = makeMockPage();
    const handle = makeHandle(null);
    const meta = await clickWithTrajectory(page, handle as any, { allowForceFallback: true });
    expect(meta.usedForce).toBe(true);
    expect(handle.forceClicks).toBe(1);
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
});
