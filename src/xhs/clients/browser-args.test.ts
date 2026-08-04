/**
 * @fileoverview C1 回归：BROWSER_ARGS 默认保留 sandbox；容器回滚 env 追加 no-sandbox。
 */
// 先加载 logger.js，规避 config.ts↔logger.ts 循环依赖在孤立测试入口下的 TDZ
import '../../core/logger.js';
import { describe, expect, it } from 'bun:test';
import { getBrowserArgs } from './constants.js';
import { config } from '../../core/config.js';

describe('C1 getBrowserArgs', () => {
  it('默认不含 no-sandbox / disable-setuid-sandbox / deny-permission-prompts', () => {
    const args = getBrowserArgs(false);
    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--disable-setuid-sandbox');
    expect(args).not.toContain('--deny-permission-prompts');
    expect(args).not.toContain('--disable-blink-features=AutomationControlled');
  });

  it('noSandbox=true 时追加 sandbox 禁用参数', () => {
    const args = getBrowserArgs(true);
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-setuid-sandbox');
    expect(args.indexOf('--no-sandbox')).toBeLessThan(args.indexOf('--disable-infobars'));
  });

  it('保留 UI 降噪类基础参数', () => {
    const args = getBrowserArgs(false);
    expect(args).toContain('--disable-infobars');
    expect(args).toContain('--disable-features=ExternalProtocolDialog');
    expect(args).toContain('--noerrdialogs');
  });

  it('当前 config 未设 XHS_MCP_BROWSER_NO_SANDBOX 时默认 false', () => {
    if (process.env.XHS_MCP_BROWSER_NO_SANDBOX === undefined) {
      expect(config.browser.noSandbox).toBe(false);
      expect(getBrowserArgs()).not.toContain('--no-sandbox');
    }
  });
});
