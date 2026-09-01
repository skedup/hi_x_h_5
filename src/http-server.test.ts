/**
 * @fileoverview HTTP 本机在场 challenge 回归测试。
 * @module http-server.test
 */
import { describe, expect, it } from 'bun:test';
import { config } from './core/config.js';
import { SERVICE_API_VERSION } from './service-api.js';

describe('service API handshake', () => {
  it('使用与 npm patch version 解耦的稳定版本', () => {
    expect(SERVICE_API_VERSION).toBe('1');
  });
});

// 延迟导入避免测试加载时启动 HTTP 依赖。
const { healthPayload, verifyPresenceToken } = await import('./http-server.js');

it('/health 投影稳定 service_api_version', () => {
  expect(healthPayload()).toEqual({
    status: 'ok',
    server: 'xhs-mcp',
    version: '2.0.0',
    service_api_version: '1',
  });
});

describe('presence challenge 轮换', () => {
  it('自然过期后生成新 challenge，服务无需重启即可继续确认', async () => {
    const serverConfig = config.server as { presenceChallengeTtlMs: number };
    const originalTtl = serverConfig.presenceChallengeTtlMs;
    const originalConsoleError = console.error;
    const messages: string[] = [];

    try {
      serverConfig.presenceChallengeTtlMs = 100;
      console.error = (...args: unknown[]) => messages.push(args.map(String).join(' '));

      expect(verifyPresenceToken(undefined)).toBe(false);
      const first = messages.at(-1)?.match(/: ([a-f0-9]{32})$/)?.[1];
      expect(first).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(verifyPresenceToken(first)).toBe(false);
      const second = messages.at(-1)?.match(/: ([a-f0-9]{32})$/)?.[1];
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(verifyPresenceToken(second)).toBe(true);
    } finally {
      console.error = originalConsoleError;
      serverConfig.presenceChallengeTtlMs = originalTtl;
    }
  });
});
