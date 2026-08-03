/**
 * @fileoverview B3 Interact 会话化单测。
 * @module xhs/utils/interact-session.test
 */
import '../../core/logger.js';
import { describe, it, expect, afterAll, beforeEach } from 'bun:test';
import { config } from '../../core/config.js';
import {
  runInteractReadingPhase,
  runInteractPostStay,
  finalizeInteractSessionMeta,
  getLastInteractSessionMeta,
  resetLastInteractSessionMeta,
} from './interact-session.js';
import type { Page } from 'patchright';

const cfg = config as any;

function makeMockPage(): Page & { wheelCalls: number } {
  let wheelCalls = 0;
  const page = {
    get wheelCalls() {
      return wheelCalls;
    },
    mouse: {
      wheel: async () => {
        wheelCalls += 1;
      },
      move: async () => {},
    },
  };
  return page as unknown as Page & { wheelCalls: number };
}

describe('B3 interact session', () => {
  const prev = { ...cfg.antiDetect.interactSession };
  const prevHt = { ...cfg.antiDetect.heavyTail };

  beforeEach(() => {
    cfg.antiDetect.interactSession = {
      enabled: true,
      preDwellMs: 100,
      postStayMs: 100,
      minReadScrolls: 1,
    };
    cfg.antiDetect.heavyTail = { enabled: false, sigma: 0.45, maxMultiplier: 8 };
    resetLastInteractSessionMeta();
  });

  afterAll(() => {
    cfg.antiDetect.interactSession = prev;
    cfg.antiDetect.heavyTail = prevHt;
  });

  it('启用时 pre dwell + ≥1 阅读滚动可观测', async () => {
    const page = makeMockPage();
    const reading = await runInteractReadingPhase(page);
    expect(reading.enabled).toBe(true);
    expect(reading.preDwellMs).toBeGreaterThanOrEqual(50); // 关闭重尾时 ±20% of 100
    expect(reading.preDwellMs).toBeLessThanOrEqual(250);
    expect(reading.readScrollCount).toBeGreaterThanOrEqual(1);
    expect(page.wheelCalls).toBeGreaterThanOrEqual(1);
  });

  it('启用时 post stay ≥ 配置采样下限', async () => {
    const post = await runInteractPostStay();
    expect(post.enabled).toBe(true);
    expect(post.postStayMs).toBeGreaterThanOrEqual(50);
    expect(post.postStayMs).toBeLessThanOrEqual(250);
  });

  it('关闭时跳过阅读与停留', async () => {
    cfg.antiDetect.interactSession = {
      enabled: false,
      preDwellMs: 100,
      postStayMs: 100,
      minReadScrolls: 1,
    };
    const page = makeMockPage();
    const reading = await runInteractReadingPhase(page);
    const post = await runInteractPostStay();
    expect(reading.enabled).toBe(false);
    expect(reading.readScrollCount).toBe(0);
    expect(page.wheelCalls).toBe(0);
    expect(post.enabled).toBe(false);
    expect(post.postStayMs).toBe(0);
  });

  it('finalize 写入 getLastInteractSessionMeta（DoD 可观测）', () => {
    const meta = finalizeInteractSessionMeta({
      enabled: true,
      preDwellMs: 900,
      readScrollCount: 2,
      postStayMs: 1100,
      trajectorySteps: 6,
      keepPage: false,
    });
    expect(meta.trajectorySteps).toBe(6);
    expect(getLastInteractSessionMeta()).toEqual(meta);
  });
});
