/**
 * @fileoverview A3（blue-team）回归测试：explore 提取 feed 后应绑定 xsecToken 来源账号，
 * 与 tools/content.ts 的 search / list_feeds 绑定模式一致（fail-closed）。
 * 用真实的进程内单例 CooccurrenceGuard（与 antidetect.test.ts 手法一致），
 * 测试前后 reset() 隔离，避免跨 case 状态泄漏。
 * @module xhs/clients/services/explore.test
 */
// 先加载 logger，规避孤立/组合测试入口下 config↔proxy↔logger 循环依赖 TDZ
import '../../../core/logger.js';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { bindFeedXsecTokens, FeedItem } from './explore.js';
import { getCooccurrenceGuard } from '../../../core/antidetect.js';
import { config } from '../../../core/config.js';

// 测试中需要强制 block 模式以确定性验证跨账号拦截；用局部可变别名绕过只读声明
const cfg = config as any;

const A = 'explore-acc-a';
const B = 'explore-acc-b';

function makeFeed(id: string, xsecToken: string): FeedItem {
  return {
    id,
    xsecToken,
    noteCard: { type: 'normal' },
  };
}

describe('A3 explore getFeeds 后绑定 xsecToken 来源账号', () => {
  const originalMode = cfg.antiDetect.xsecTokenBinding.mode;
  const originalEnabled = cfg.antiDetect.xsecTokenBinding.enabled;

  beforeEach(() => {
    getCooccurrenceGuard().reset();
    cfg.antiDetect.xsecTokenBinding.enabled = true;
    cfg.antiDetect.xsecTokenBinding.mode = 'block';
  });

  afterEach(() => {
    cfg.antiDetect.xsecTokenBinding.mode = originalMode;
    cfg.antiDetect.xsecTokenBinding.enabled = originalEnabled;
    getCooccurrenceGuard().reset();
  });

  it('getFeeds 提取的每个 feed 的 token 都绑定到提取账号', async () => {
    const feeds = [makeFeed('note-1', 'tok-1'), makeFeed('note-2', 'tok-2')];
    await bindFeedXsecTokens(feeds, A);

    const guard = getCooccurrenceGuard();
    expect(guard.checkXsecSource('tok-1', A).allow).toBe(true);
    expect(guard.checkXsecSource('tok-2', A).allow).toBe(true);
  });

  it('B 账号使用 A 提取的 token 写操作在 block 模式下被拒绝', async () => {
    const feeds = [makeFeed('note-1', 'tok-shared')];
    await bindFeedXsecTokens(feeds, A);

    const guard = getCooccurrenceGuard();
    const check = guard.checkXsecSource('tok-shared', B);
    expect(check.allow).toBe(false);
    expect(check.reason).toBe('xsec_token_bound_to_other_account');
  });

  it('首个提取账号占用来源，后续同 token 不同账号的提取不会抢占', async () => {
    await bindFeedXsecTokens([makeFeed('note-1', 'tok-x')], A);
    await bindFeedXsecTokens([makeFeed('note-1', 'tok-x')], B); // 抢占无效

    const guard = getCooccurrenceGuard();
    expect(guard.checkXsecSource('tok-x', A).allow).toBe(true);
    expect(guard.checkXsecSource('tok-x', B).allow).toBe(false);
  });

  it('跳过没有 xsecToken 的 feed，不抛错', async () => {
    const feeds = [{ id: 'note-no-token', xsecToken: '', noteCard: { type: 'normal' } } as FeedItem];
    await expect(bindFeedXsecTokens(feeds, A)).resolves.toBeUndefined();
  });
});
