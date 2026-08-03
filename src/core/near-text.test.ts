/**
 * @fileoverview D2：评论文本归一化 / simhash / 近邻判定单测。
 * @module core/near-text.test
 */
import { describe, it, expect } from 'bun:test';
import {
  normalizeCommentText,
  hamming64,
  fingerprintFromHex,
  commentNearFingerprint,
  isNearDuplicateText,
} from './near-text.js';

describe('normalizeCommentText', () => {
  it('去标点空白并小写', () => {
    expect(normalizeCommentText('今天天气真好！')).toBe(normalizeCommentText('今天天气真好'));
    expect(normalizeCommentText('Hello  World')).toBe('helloworld');
  });

  it('全角折半角', () => {
    expect(normalizeCommentText('Ｈｅｌｌｏ')).toBe('hello');
  });
});

describe('simhash / near', () => {
  it('近邻文案 Hamming 小', () => {
    const a = commentNearFingerprint('今天天气真好')!;
    const b = commentNearFingerprint('今天天气真好！')!;
    expect(hamming64(fingerprintFromHex(a), fingerprintFromHex(b))).toBeLessThanOrEqual(3);
    expect(isNearDuplicateText('今天天气真好', '今天天气真好！', 3)).toBe(true);
  });

  it('明显不同文案不近邻', () => {
    expect(isNearDuplicateText('今天天气真好', '这家火锅太辣了推荐', 3)).toBe(false);
  });

  it('空文案跳过', () => {
    expect(commentNearFingerprint('!!!')).toBeNull();
  });
});
