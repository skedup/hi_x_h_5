/**
 * @fileoverview B1 行为重尾延迟采样单测。
 * @module xhs/utils/heavy-tail.test
 */
import '../../core/logger.js';
import { describe, it, expect, afterAll } from 'bun:test';
import { config } from '../../core/config.js';
import { sampleHeavyTailMs } from './index.js';

const cfg = config as any;

describe('B1 sampleHeavyTailMs', () => {
  const prev = { ...cfg.antiDetect.heavyTail };

  afterAll(() => {
    cfg.antiDetect.heavyTail = prev;
  });

  it('启用时中位数接近 base，P95 明显高于中位数（右尾）', () => {
    cfg.antiDetect.heavyTail = { enabled: true, sigma: 0.45, maxMultiplier: 8 };
    const base = 100;
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      samples.push(sampleHeavyTailMs(base, { minMs: 1, maxMs: 800 }));
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(median).toBeGreaterThan(60);
    expect(median).toBeLessThan(160);
    expect(p95).toBeGreaterThan(median * 1.4);
  });

  it('关闭且提供 min/max 时在该区间均匀（对齐迁移前分布）', () => {
    cfg.antiDetect.heavyTail = { enabled: false, sigma: 0.45, maxMultiplier: 8 };
    for (let i = 0; i < 200; i++) {
      const v = sampleHeavyTailMs(350, { minMs: 200, maxMs: 500 });
      expect(v).toBeGreaterThanOrEqual(200);
      expect(v).toBeLessThanOrEqual(500);
    }
  });

  it('关闭时落在窄带均匀区间', () => {
    cfg.antiDetect.heavyTail = { enabled: false, sigma: 0.45, maxMultiplier: 8 };
    const base = 100;
    for (let i = 0; i < 200; i++) {
      const v = sampleHeavyTailMs(base);
      expect(v).toBeGreaterThanOrEqual(80);
      expect(v).toBeLessThanOrEqual(120);
    }
  });

  it('尊重 minMs/maxMs 夹紧', () => {
    cfg.antiDetect.heavyTail = { enabled: true, sigma: 0.8, maxMultiplier: 20 };
    for (let i = 0; i < 500; i++) {
      const v = sampleHeavyTailMs(100, { minMs: 90, maxMs: 110 });
      expect(v).toBeGreaterThanOrEqual(90);
      expect(v).toBeLessThanOrEqual(110);
    }
  });

  it('B6：min≠max 时不恒为 base（findCommentElement 滚动步间）', () => {
    cfg.antiDetect.heavyTail = { enabled: true, sigma: 0.45, maxMultiplier: 8 };
    const samples = new Set<number>();
    for (let i = 0; i < 100; i++) {
      samples.add(sampleHeavyTailMs(800, { minMs: 500, maxMs: 1400 }));
    }
    expect(samples.size).toBeGreaterThan(1);
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1400);
    }
  });
});
