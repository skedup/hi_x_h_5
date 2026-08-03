/**
 * @fileoverview B5 typing.mode / IME wontfix 解析单测。
 * @module xhs/utils/typing-mode.test
 */
import '../../core/logger.js';
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { config } from '../../core/config.js';
import { resolveTypingMode, resetImeWontfixWarnGate } from './index.js';

const cfg = config as any;

describe('B5 resolveTypingMode', () => {
  const prev = { ...(cfg.antiDetect.typing ?? { mode: 'direct' }) };

  beforeEach(() => {
    cfg.antiDetect.typing = { mode: 'direct' };
    resetImeWontfixWarnGate();
  });

  afterAll(() => {
    cfg.antiDetect.typing = prev;
  });

  it('direct → direct', () => {
    expect(resolveTypingMode('direct', false)).toBe('direct');
  });

  it('ime → direct（wontfix 降级）', () => {
    expect(resolveTypingMode('ime', false)).toBe('direct');
  });

  it('读 config.antiDetect.typing.mode=ime 时仍降级 direct', () => {
    cfg.antiDetect.typing = { mode: 'ime' };
    expect(resolveTypingMode(undefined, false)).toBe('direct');
  });
});
