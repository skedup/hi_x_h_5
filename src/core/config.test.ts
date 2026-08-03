/**
 * @fileoverview A3（blue-team）回归测试：xsecToken 绑定模式默认值。
 * config.ts 在模块加载时即读取 process.env 生成单例，无法在同一进程内
 * 反复模拟"env 未设置"的加载时刻；因此把默认值解析逻辑抽成纯函数
 * `parseXsecMode` 单独测试，同时用真实 config 单例断言其当前生效值。
 * @module core/config.test
 */
// 先加载 logger.js，规避 config.ts↔proxy.ts↔logger.ts 既有循环依赖在孤立测试入口下的 TDZ
import './logger.js';
import { describe, it, expect } from 'bun:test';
import {
  parseXsecMode,
  parseTypingMode,
  resolveLoginHeadless,
  assertDisplayAvailableForHeadful,
} from './config.js';
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

describe('B5 typing.mode', () => {
  it('默认 direct', () => {
    expect(parseTypingMode(undefined, 'direct')).toBe('direct');
  });

  it('接受 ime / composition 别名', () => {
    expect(parseTypingMode('ime', 'direct')).toBe('ime');
    expect(parseTypingMode('composition', 'direct')).toBe('ime');
  });

  it('接受 codepoint / keyboard 别名为 direct', () => {
    expect(parseTypingMode('codepoint', 'direct')).toBe('direct');
    expect(parseTypingMode('keyboard', 'direct')).toBe('direct');
  });

  it('非法值回退默认', () => {
    expect(parseTypingMode('bogus', 'direct')).toBe('direct');
  });

  it('当前 config 默认 typing.mode 为 direct（未设 env 时）', () => {
    if (process.env.XHS_MCP_AD_TYPING_MODE === undefined) {
      expect(config.antiDetect.typing.mode).toBe('direct');
    }
  });
});

describe('C2 登录 headless 解析', () => {
  it('allow=false 时忽略全局 headless=true，强制 headful', () => {
    expect(resolveLoginHeadless(true, false)).toBe(false);
  });

  it('allow=false 时 headless=false 仍为 headful', () => {
    expect(resolveLoginHeadless(false, false)).toBe(false);
  });

  it('allow=true 时沿用全局 headless', () => {
    expect(resolveLoginHeadless(true, true)).toBe(true);
    expect(resolveLoginHeadless(false, true)).toBe(false);
  });

  it('当前进程未设 XHS_MCP_ALLOW_HEADLESS_LOGIN 时 allowHeadlessLogin 为 false', () => {
    if (process.env.XHS_MCP_ALLOW_HEADLESS_LOGIN === undefined) {
      expect(config.browser.allowHeadlessLogin).toBe(false);
    }
  });
});

describe('C2 assertDisplayAvailableForHeadful', () => {
  it('Linux 无 DISPLAY/WAYLAND 时抛出明确错误', () => {
    const platform = process.platform;
    const display = process.env.DISPLAY;
    const wayland = process.env.WAYLAND_DISPLAY;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      expect(() => assertDisplayAvailableForHeadful()).toThrow(/Xvfb|XHS_MCP_ALLOW_HEADLESS_LOGIN/);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      if (display !== undefined) process.env.DISPLAY = display;
      else delete process.env.DISPLAY;
      if (wayland !== undefined) process.env.WAYLAND_DISPLAY = wayland;
      else delete process.env.WAYLAND_DISPLAY;
    }
  });

  it('Linux 有 DISPLAY 时不抛错', () => {
    const platform = process.platform;
    const display = process.env.DISPLAY;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      process.env.DISPLAY = ':99';
      expect(() => assertDisplayAvailableForHeadful()).not.toThrow();
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      if (display !== undefined) process.env.DISPLAY = display;
      else delete process.env.DISPLAY;
    }
  });
});
