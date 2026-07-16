/**
 * @fileoverview C3.2 息屏自保单元测试（离线）。
 * 覆盖显示器状态判定（fail-open）与 queryDisplayPowerState 不抛错。
 * @module core/liveness.test
 */
import { describe, it, expect } from 'bun:test';
import { isAsleepState, queryDisplayPowerState } from './liveness.js';

describe('C3.2 显示器 asleep 判定（fail-open）', () => {
  it('无法判定（null）→ awake（放行）', () => {
    expect(isAsleepState(null)).toBe(false);
  });
  it('完全点亮（4）→ awake', () => {
    expect(isAsleepState(4)).toBe(false);
  });
  it('睡眠阈值下限（1）→ asleep', () => {
    expect(isAsleepState(1)).toBe(true);
  });
  it('完全关闭（0）→ asleep', () => {
    expect(isAsleepState(0)).toBe(true);
  });
  it('过渡态（2/3）→ awake（避免因 dim 误杀）', () => {
    expect(isAsleepState(2)).toBe(false);
    expect(isAsleepState(3)).toBe(false);
  });
});

describe('C3.2 queryDisplayPowerState', () => {
  it('返回 Promise<number|null> 且不抛错', async () => {
    const p = queryDisplayPowerState();
    expect(p).toBeInstanceOf(Promise);
    const v = await p;
    expect(v === null || typeof v === 'number').toBe(true);
  });
});
