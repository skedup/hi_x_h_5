/**
 * @fileoverview A3（blue-team）回归测试：xsecToken 绑定模式默认值。
 * config.ts 在模块加载时即读取 process.env 生成单例，无法在同一进程内
 * 反复模拟"env 未设置"的加载时刻；因此把默认值解析逻辑抽成纯函数
 * `parseXsecMode` 单独测试，同时用真实 config 单例断言其当前生效值。
 * @module core/config.test
 */
import { describe, it, expect } from 'bun:test';
import { parseXsecMode } from './config.js';
import { config } from './config.js';

describe('A3 xsecToken 绑定默认模式收紧为 block', () => {
  it('env 未设置时默认 block（breaking：此前默认 warn）', () => {
    expect(parseXsecMode(undefined, 'block')).toBe('block');
  });

  it('env 显式设为 warn 时可回滚', () => {
    expect(parseXsecMode('warn', 'block')).toBe('warn');
  });

  it('env 显式设为 block 时保持 block', () => {
    expect(parseXsecMode('block', 'block')).toBe('block');
  });

  it('env 为非法值时回退到默认值', () => {
    expect(parseXsecMode('bogus', 'block')).toBe('block');
  });

  it('当前进程加载的真实 config：未设置 XHS_MCP_AD_XSEC_MODE 时应为 block', () => {
    // 本仓库运行测试时不会设置该 env（见下方断言防御性检查），因此当前单例应体现新默认值。
    if (process.env.XHS_MCP_AD_XSEC_MODE === undefined) {
      expect(config.antiDetect.xsecTokenBinding.mode).toBe('block');
    }
  });
});
