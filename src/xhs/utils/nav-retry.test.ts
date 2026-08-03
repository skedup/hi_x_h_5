/**
 * @fileoverview B7 导航重试间隔采样单测。
 * @module xhs/utils/nav-retry.test
 */
import '../../core/logger.js';
import { describe, it, expect, afterAll } from 'bun:test';
import { config } from '../../core/config.js';
import { sampleNavRetryDelayMs, NAVIGATE_RETRY_DELAY_MS } from './index.js';

const cfg = config as any;

describe('B7 sampleNavRetryDelayMs', () => {
  const prevNav = { ...cfg.antiDetect.navRetryHeavyTail };
  const prevHt = { ...cfg.antiDetect.heavyTail };

  afterAll(() => {
    cfg.antiDetect.navRetryHeavyTail = prevNav;
    cfg.antiDetect.heavyTail = prevHt;
  });

  it('启用重尾时 P95 明显高于中位数（非均匀分布）', () => {
    cfg.antiDetect.navRetryHeavyTail = { enabled: true };
    cfg.antiDetect.heavyTail = { enabled: true, sigma: 0.45, maxMultiplier: 8 };
    const [lo, hi] = NAVIGATE_RETRY_DELAY_MS;
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      samples.push(sampleNavRetryDelayMs([lo, hi]));
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(median).toBeGreaterThanOrEqual(lo);
    expect(median).toBeLessThanOrEqual(hi);
    expect(p95).toBeGreaterThan(median * 1.2);
  });

  it('关闭 navRetryHeavyTail 时在 [min, max] 均匀（迁移前行为）', () => {
    cfg.antiDetect.navRetryHeavyTail = { enabled: false };
    const [lo, hi] = NAVIGATE_RETRY_DELAY_MS;
    for (let i = 0; i < 300; i++) {
      const v = sampleNavRetryDelayMs([lo, hi]);
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  it('均匀模式下 P95 与中位数接近（无重尾）', () => {
    cfg.antiDetect.navRetryHeavyTail = { enabled: false };
    const [lo, hi] = NAVIGATE_RETRY_DELAY_MS;
    const samples: number[] = [];
    for (let i = 0; i < 3000; i++) {
      samples.push(sampleNavRetryDelayMs([lo, hi]));
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(median * 1.35);
  });
});
