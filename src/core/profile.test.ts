/**
 * @fileoverview 蓝军 #2 回归测试：finalizeLoginProfile 原子替换（归档旧目录、转正新会话）。
 * @module core/profile.test
 */
import { describe, it, expect } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  adoptSingleLegacyProfile,
  generateProfileId,
  getLoginProfileDir,
  finalizeLoginProfile,
} from './profile.js';
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

function legacyFixture(base: string, status: 'active' | 'migration_required' = 'active') {
  const account: {
    id: string;
    status: 'active' | 'suspended' | 'banned' | 'migration_required';
    profileId?: string;
  } = { id: 'legacy-account', status };
  const legacyProfile = join(base, 'browser-profile');
  const marker = join(base, 'browser-profile.adoption.json');
  const getProfileDir = (profileId: string) => join(base, 'browser-profiles', profileId);
  mkdirSync(legacyProfile, { recursive: true, mode: 0o700 });
  chmodSync(legacyProfile, 0o700);
  writeFileSync(join(legacyProfile, 'cookie-marker'), 'preserved');
  const store = {
    findAll: () => [account],
    findById: (id: string) => (id === account.id ? account : null),
    setProfileId: (id: string, profileId: string) => {
      if (id !== account.id || account.profileId) return false;
      account.profileId = profileId;
      return true;
    },
    updateConfig: (id: string, updates: { status?: typeof account.status }) => {
      if (id === account.id && updates.status) account.status = updates.status;
    },
  };
  return { account, legacyProfile, marker, getProfileDir, store };
}

describe('单账号旧 profile 兼容迁移', () => {
  it('移动到 UUID 独立目录并保留旧路径符号链接供回滚', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-adopt-'));
    const fixture = legacyFixture(base);
    try {
      const result = adoptSingleLegacyProfile(fixture.store, {
        legacyProfile: fixture.legacyProfile,
        adoptionMarker: fixture.marker,
        getProfileDir: fixture.getProfileDir,
      });

      expect(result.adopted).toBe(true);
      expect(result.profileId).toBe(fixture.account.profileId);
      expect(fixture.account.profileId).toMatch(/^[0-9a-f-]{36}$/);
      const isolated = fixture.getProfileDir(fixture.account.profileId!);
      expect(existsSync(join(isolated, 'cookie-marker'))).toBe(true);
      expect(lstatSync(fixture.legacyProfile).isSymbolicLink()).toBe(true);
      // 旧版本仍从 browser-profile 读取到同一份状态，代码回滚无需恢复数据库或复制 profile。
      expect(existsSync(join(fixture.legacyProfile, 'cookie-marker'))).toBe(true);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('多账号旧库不猜测共享 profile 归属，保持 fail-closed 前置状态', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-multi-'));
    const fixture = legacyFixture(base);
    const second = { id: 'second', status: 'active' as const, profileId: undefined };
    const store = { ...fixture.store, findAll: () => [fixture.account, second] };
    try {
      expect(
        adoptSingleLegacyProfile(store, {
          legacyProfile: fixture.legacyProfile,
          adoptionMarker: fixture.marker,
          getProfileDir: fixture.getProfileDir,
        }),
      ).toEqual({ adopted: false });
      expect(fixture.account.profileId).toBeUndefined();
      expect(lstatSync(fixture.legacyProfile).isDirectory()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('仅有初始化产生的空目录时不绑定账号，交由 migration_required 流程处理', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-empty-'));
    const fixture = legacyFixture(base);
    rmSync(join(fixture.legacyProfile, 'cookie-marker'));
    try {
      expect(
        adoptSingleLegacyProfile(fixture.store, {
          legacyProfile: fixture.legacyProfile,
          adoptionMarker: fixture.marker,
          getProfileDir: fixture.getProfileDir,
        }),
      ).toEqual({ adopted: false });
      expect(fixture.account.profileId).toBeUndefined();
      expect(existsSync(fixture.marker)).toBe(false);
      expect(lstatSync(fixture.legacyProfile).isDirectory()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('迁移已开始后账号集合发生变化时拒绝继续，保留 marker 供人工恢复', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-marker-conflict-'));
    const fixture = legacyFixture(base);
    const second = { id: 'second', status: 'active' as const, profileId: undefined };
    const store = { ...fixture.store, findAll: () => [fixture.account, second] };
    const profileId = generateProfileId();
    try {
      writeFileSync(fixture.marker, `${JSON.stringify({ profileId })}\n`, { mode: 0o600 });
      expect(() =>
        adoptSingleLegacyProfile(store, {
          legacyProfile: fixture.legacyProfile,
          adoptionMarker: fixture.marker,
          getProfileDir: fixture.getProfileDir,
        }),
      ).toThrow('legacy profile adoption marker requires exactly one account');
      expect(existsSync(fixture.marker)).toBe(true);
      expect(fixture.account.profileId).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('数据库绑定中断后复用 marker 与兼容链接完成恢复，不生成第二个 profile', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-recover-'));
    const fixture = legacyFixture(base, 'migration_required');
    let failOnce = true;
    const store = {
      ...fixture.store,
      setProfileId: (id: string, profileId: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated database interruption');
        }
        return fixture.store.setProfileId(id, profileId);
      },
    };
    const pathConfig = {
      legacyProfile: fixture.legacyProfile,
      adoptionMarker: fixture.marker,
      getProfileDir: fixture.getProfileDir,
    };
    try {
      expect(() => adoptSingleLegacyProfile(store, pathConfig)).toThrow('simulated database interruption');
      expect(lstatSync(fixture.legacyProfile).isSymbolicLink()).toBe(true);
      const entriesBefore = readdirSync(join(base, 'browser-profiles'));

      const recovered = adoptSingleLegacyProfile(store, pathConfig);
      expect(recovered.adopted).toBe(true);
      expect(fixture.account.status).toBe('active');
      expect(readdirSync(join(base, 'browser-profiles'))).toEqual(entriesBefore);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
