/**
 * @fileoverview B4 Explore 纯逻辑单测：打开率冷却/衰减、视频接触率。
 * @module xhs/clients/services/explore-helpers.test
 */
import { describe, it, expect } from 'bun:test';
import {
  computeEffectiveOpenRate,
  computeFeedVideoRatio,
  createOpenRateCooldownState,
  OPEN_RATE_COOLDOWN,
  shouldContactVideoFeed,
  updateOpenRateStateAfterRound,
} from './explore-helpers.js';

describe('B4 打开率冷却/衰减', () => {
  it('初始状态等于基线打开率', () => {
    const state = createOpenRateCooldownState();
    expect(computeEffectiveOpenRate(0.5, state)).toBeCloseTo(0.5, 5);
  });

  it('成功打开后有效打开率下降（冷却惩罚）', () => {
    let state = createOpenRateCooldownState();
    state = updateOpenRateStateAfterRound(state, true);
    const rate = computeEffectiveOpenRate(0.5, state);
    expect(rate).toBeLessThan(0.5);
    expect(state.cooldownPenalty).toBe(OPEN_RATE_COOLDOWN.PENALTY_PER_OPEN);
  });

  it('连续打开惩罚累积至上限', () => {
    let state = createOpenRateCooldownState();
    for (let i = 0; i < 10; i++) {
      state = updateOpenRateStateAfterRound(state, true);
    }
    expect(state.cooldownPenalty).toBe(OPEN_RATE_COOLDOWN.MAX_PENALTY);
  });

  it('未打开轮次缓慢恢复冷却并增加兜底加成', () => {
    let state = updateOpenRateStateAfterRound(createOpenRateCooldownState(), true);
    const afterOpen = computeEffectiveOpenRate(0.5, state);
    for (let i = 0; i < 5; i++) {
      state = updateOpenRateStateAfterRound(state, false);
    }
    const afterIdle = computeEffectiveOpenRate(0.5, state);
    expect(afterIdle).toBeGreaterThan(afterOpen);
    expect(state.cooldownPenalty).toBeLessThan(OPEN_RATE_COOLDOWN.PENALTY_PER_OPEN);
    expect(state.idleRounds).toBe(5);
  });

  it('有效打开率钳制在 MIN~MAX', () => {
    const highState = { cooldownPenalty: 0, idleRounds: 100 };
    expect(computeEffectiveOpenRate(0.95, highState)).toBe(OPEN_RATE_COOLDOWN.MAX_RATE);

    const lowState = { cooldownPenalty: 0.9, idleRounds: 0 };
    expect(computeEffectiveOpenRate(0.01, lowState)).toBe(OPEN_RATE_COOLDOWN.MIN_RATE);
  });
});

describe('B4 视频接触率', () => {
  it('computeFeedVideoRatio 正确统计占比', () => {
    const feeds = [
      { noteCard: { type: 'normal' } },
      { noteCard: { type: 'video' } },
      { noteCard: { type: 'normal' } },
      { noteCard: { type: 'video' } },
    ];
    expect(computeFeedVideoRatio(feeds)).toBe(0.5);
    expect(computeFeedVideoRatio([])).toBe(0);
  });

  it('无视频时 shouldContactVideoFeed 恒 false', () => {
    expect(shouldContactVideoFeed(0, 0)).toBe(false);
  });

  it('接触率与视频占比成比例（roll 边界）', () => {
    const ratio = 0.4;
    expect(shouldContactVideoFeed(ratio, 0.45)).toBe(true);
    expect(shouldContactVideoFeed(ratio, 0.47)).toBe(false);
  });

  it('低视频占比时有下限 0.08', () => {
    expect(shouldContactVideoFeed(0.02, 0.07)).toBe(true);
    expect(shouldContactVideoFeed(0.02, 0.09)).toBe(false);
  });
});
