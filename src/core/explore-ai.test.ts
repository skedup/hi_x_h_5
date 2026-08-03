/**
 * @fileoverview explore-ai 兜底行为回归测试（蓝军 A4）。
 * 覆盖：
 * - generateComment 解析失败 / 调用异常时禁止返回固定文案「很棒的分享！」，
 *   必须返回 { comment: null, skip: true } 供调用方跳过。
 * - selectLikeTarget 解析失败 / 调用异常时禁止默认 target:'post'，必须返回 target:'none'。
 * 通过 mock `@google/genai` 与 `prompt-manager` 隔离网络与文件系统依赖。
 * @module core/explore-ai.test
 */
// 先加载 logger.js，规避 config.ts↔proxy.ts↔logger.ts 既有循环依赖在孤立测试入口下的
// 模块初始化顺序问题（TDZ）；应用整体运行时因入口链路不同不会触发，测试文件需显式规避。
import './logger.js';
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// generateComment/selectLikeTarget 在模块内会立即校验 apiKey，需先设置再动态导入被测模块。
process.env.GEMINI_API_KEY = 'test-key-explore-ai';

// 用可变引用让每个用例独立控制 mock 行为
let generateContentImpl: (...args: any[]) => Promise<{ text: string }> = async () => ({ text: '{}' });

mock.module('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: (...args: any[]) => generateContentImpl(...args),
    };
  },
}));

// 跳过真实文件系统 prompt 渲染，专注测试兜底契约
mock.module('./prompt-manager.js', () => ({
  renderPrompt: async () => 'mocked-prompt',
}));

const { generateComment, selectLikeTarget } = await import('./explore-ai.js');

const ACCOUNT = { id: 'acc-1', name: 'tester' };

describe('A4 · generateComment 禁止固定兜底文案', () => {
  beforeEach(() => {
    generateContentImpl = async () => ({ text: '{}' });
  });

  it('AI 返回非法 JSON（解析失败）→ skip:true，comment:null，且非「很棒的分享！」', async () => {
    generateContentImpl = async () => ({ text: '这不是合法的 JSON' });
    const result = await generateComment(ACCOUNT, '标题', '正文');
    expect(result.skip).toBe(true);
    expect(result.comment).toBeNull();
    expect(result.comment).not.toBe('很棒的分享！');
  });

  it('AI 返回 JSON 但缺少 comment 字段 → skip:true，comment:null', async () => {
    generateContentImpl = async () => ({ text: '{"foo":"bar"}' });
    const result = await generateComment(ACCOUNT, '标题', '正文');
    expect(result.skip).toBe(true);
    expect(result.comment).toBeNull();
  });

  it('AI 调用抛出异常（catch 分支）→ skip:true，comment:null，且非「很棒的分享！」', async () => {
    generateContentImpl = async () => {
      throw new Error('network down');
    };
    const result = await generateComment(ACCOUNT, '标题', '正文');
    expect(result.skip).toBe(true);
    expect(result.comment).toBeNull();
    expect(result.comment).not.toBe('很棒的分享！');
  });

  it('AI 正常返回合法评论 → skip:false，透传评论文本', async () => {
    generateContentImpl = async () => ({ text: '{"comment":"这条笔记真不错"}' });
    const result = await generateComment(ACCOUNT, '标题', '正文');
    expect(result.skip).toBe(false);
    expect(result.comment).toBe('这条笔记真不错');
  });
});

describe('A4 · selectLikeTarget 失败禁止默认点赞帖子', () => {
  beforeEach(() => {
    generateContentImpl = async () => ({ text: '{}' });
  });

  it('AI 返回非法 JSON（解析失败）→ target:none（非 post）', async () => {
    generateContentImpl = async () => ({ text: '不是 JSON' });
    const result = await selectLikeTarget(ACCOUNT, '标题', '描述', []);
    expect(result.target).toBe('none');
    expect(result.target).not.toBe('post');
  });

  it('AI 返回 JSON 但缺少 target 字段 → target:none', async () => {
    generateContentImpl = async () => ({ text: '{"reason":"随便"}' });
    const result = await selectLikeTarget(ACCOUNT, '标题', '描述', []);
    expect(result.target).toBe('none');
  });

  it('AI 调用抛出异常（catch 分支）→ target:none（非 post）', async () => {
    generateContentImpl = async () => {
      throw new Error('network down');
    };
    const result = await selectLikeTarget(ACCOUNT, '标题', '描述', []);
    expect(result.target).toBe('none');
    expect(result.target).not.toBe('post');
  });

  it('AI 正常返回 target:post → 按 AI 决策透传（成功路径不受影响）', async () => {
    generateContentImpl = async () => ({ text: '{"target":"post","reason":"内容不错"}' });
    const result = await selectLikeTarget(ACCOUNT, '标题', '描述', []);
    expect(result.target).toBe('post');
  });
});
