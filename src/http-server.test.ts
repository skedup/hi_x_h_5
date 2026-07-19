/**
 * @fileoverview HTTP 本机在场 challenge 回归测试。
 * @module http-server.test
 */
import { describe, expect, it } from 'bun:test';
import { config } from './core/config.js';
import { verifyPresenceToken } from './http-server.js';

describe('presence challenge 轮换', () => {
  it('自然过期后生成新 challenge，服务无需重启即可继续确认', async () => {
    const serverConfig = config.server as { presenceChallengeTtlMs: number };
    const originalTtl = serverConfig.presenceChallengeTtlMs;
    const originalConsoleError = console.error;
    const messages: string[] = [];

    try {
      serverConfig.presenceChallengeTtlMs = 5;
      console.error = (...args: unknown[]) => messages.push(args.map(String).join(' '));

      expect(verifyPresenceToken(undefined)).toBe(false);
      const first = messages.at(-1)?.match(/: ([a-f0-9]{32})$/)?.[1];
      expect(first).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 15));
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
