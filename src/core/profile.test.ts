/**
 * @fileoverview 蓝军 #2 回归测试：finalizeLoginProfile 原子替换（归档旧目录、转正新会话）。
 * @module core/profile.test
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { generateProfileId, getLoginProfileDir, finalizeLoginProfile } from './profile.js';
import { paths } from './config.js';

const getBrowserProfileDir = (id: string) => paths.getBrowserProfileDir(id);

describe('蓝军 #2 finalizeLoginProfile 原子替换', () => {
  it('目标已存在时归档旧目录并转正新会话目录，临时目录不残留', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-prof-'));
    const profileId = generateProfileId();
    const sessionId = 'sess-atomic';
    const loginDir = getLoginProfileDir(sessionId);
    const targetDir = getBrowserProfileDir(profileId);
    try {
      mkdirSync(targetDir, { recursive: true });
      mkdirSync(loginDir, { recursive: true });

      // 旧 profile 已有内容
      writeFileSync(join(targetDir, 'old.txt'), 'old-cookie');
      // 新登录会话目录（临时）有内容
      writeFileSync(join(loginDir, 'new.txt'), 'new-cookie');

      finalizeLoginProfile(sessionId, profileId);

      // 新内容已转正到目标 profile 目录
      expect(existsSync(join(targetDir, 'new.txt'))).toBe(true);
      // 旧内容被归档（目录名前缀为 profileId + '.archived-'）
      const archived = readdirSync(dirname(targetDir)).find((e) => e.startsWith(`${profileId}.archived-`));
      expect(archived).toBeDefined();
      expect(existsSync(join(dirname(targetDir), archived!, 'old.txt'))).toBe(true);
      // 临时登录目录已消费（不再残留）
      expect(existsSync(loginDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
      const parent = dirname(targetDir);
      for (const e of readdirSync(parent)) {
        if (e.startsWith(`${profileId}.archived-`)) rmSync(join(parent, e), { recursive: true, force: true });
      }
    }
  });

  it('登录会话目录不存在时为 no-op，不报错', () => {
    const profileId = generateProfileId();
    const targetDir = getBrowserProfileDir(profileId);
    try {
      expect(() => finalizeLoginProfile('no-such-session', profileId)).not.toThrow();
      expect(existsSync(targetDir)).toBe(false);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
