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
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import {
  adoptSingleLegacyProfile,
  generateProfileId,
  getLoginProfileDir,
  finalizeLoginProfile,
  removeAccountProfile,
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
  const migrationLock = join(base, 'browser-profile.migration.lock');
  const getProfileDir = (profileId: string) => join(base, 'browser-profiles', profileId);
  mkdirSync(legacyProfile, { recursive: true, mode: 0o700 });
  chmodSync(legacyProfile, 0o700);
  writeFileSync(join(legacyProfile, 'cookie-marker'), 'preserved');
  const store = {
    findAll: () => [account],
    findById: (id: string) => (id === account.id ? account : null),
    adoptLegacyProfile: (id: string, profileId: string) => {
      if (
        id !== account.id ||
        (account.profileId !== undefined && account.profileId !== profileId) ||
        (account.status !== 'active' && account.status !== 'migration_required')
      )
        return false;
      account.profileId = profileId;
      account.status = 'active';
      return true;
    },
  };
  return { account, legacyProfile, marker, migrationLock, getProfileDir, store };
}

function adoptionOptions(fixture: ReturnType<typeof legacyFixture>, confirmOwner = true) {
  return {
    ...(confirmOwner ? { expectedAccountId: fixture.account.id } : {}),
    paths: {
      legacyProfile: fixture.legacyProfile,
      adoptionMarker: fixture.marker,
      migrationLock: fixture.migrationLock,
      getProfileDir: fixture.getProfileDir,
    },
  };
}

function writeAdoptionMarker(fixture: ReturnType<typeof legacyFixture>, accountId: string, profileId: string) {
  writeFileSync(fixture.marker, `${JSON.stringify({ version: 1, accountId, profileId })}\n`, { mode: 0o600 });
}

describe('单账号旧 profile 兼容迁移', () => {
  it('移动到 UUID 独立目录并保留旧路径符号链接供回滚', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-adopt-'));
    const fixture = legacyFixture(base);
    try {
      const result = adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture));

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
      expect(adoptSingleLegacyProfile(store, adoptionOptions(fixture))).toEqual({ adopted: false });
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
      expect(adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture))).toEqual({ adopted: false });
      expect(fixture.account.profileId).toBeUndefined();
      expect(existsSync(fixture.marker)).toBe(false);
      expect(lstatSync(fixture.legacyProfile).isDirectory()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('没有显式账号归属确认时拒绝接管，即使当前仅剩一个 migration_required 账号', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-owner-required-'));
    const fixture = legacyFixture(base, 'migration_required');
    try {
      expect(() => adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture, false))).toThrow(
        'legacy profile owner confirmation is required',
      );
      expect(fixture.account.profileId).toBeUndefined();
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('仅在显式确认唯一账号归属后原子升级旧版 marker 并完成迁移', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-v0-marker-'));
    const fixture = legacyFixture(base, 'migration_required');
    const profileId = generateProfileId();
    writeFileSync(fixture.marker, `${JSON.stringify({ profileId })}\n`, { mode: 0o600 });
    try {
      expect(() => adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture, false))).toThrow(
        'legacy profile owner confirmation is required to upgrade the old adoption marker',
      );
      expect(JSON.parse(readFileSync(fixture.marker, 'utf8'))).toEqual({ profileId });

      expect(adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture))).toEqual({ adopted: true, profileId });
      expect(fixture.account).toMatchObject({ status: 'active', profileId });
      expect(lstatSync(fixture.legacyProfile).isSymbolicLink()).toBe(true);
      expect(existsSync(join(fixture.getProfileDir(profileId), 'cookie-marker'))).toBe(true);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('自动回收同主机已退出进程遗留的迁移锁', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-stale-lock-'));
    const fixture = legacyFixture(base);
    mkdirSync(fixture.migrationLock, { mode: 0o700 });
    chmodSync(fixture.migrationLock, 0o700);
    writeFileSync(
      join(fixture.migrationLock, 'owner.json'),
      `${JSON.stringify({
        version: 1,
        token: generateProfileId(),
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    try {
      expect(adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture))).toMatchObject({ adopted: true });
      expect(existsSync(fixture.migrationLock)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('marker 绑定原账号，唯一账号被替换后拒绝把旧 Cookie 绑定给新账号', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-owner-changed-'));
    const fixture = legacyFixture(base);
    const profileId = generateProfileId();
    writeAdoptionMarker(fixture, fixture.account.id, profileId);
    fixture.account.id = 'replacement-account';
    try {
      expect(() => adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture, false))).toThrow(
        'legacy profile adoption marker belongs to another account',
      );
      expect(fixture.account.profileId).toBeUndefined();
      expect(existsSync(fixture.marker)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('迁移完成且 marker 已消费后忽略遗留的 owner 环境配置', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-stale-owner-env-'));
    const fixture = legacyFixture(base);
    fixture.account.profileId = generateProfileId();
    try {
      expect(
        adoptSingleLegacyProfile(fixture.store, {
          ...adoptionOptions(fixture, false),
          expectedAccountId: 'removed-legacy-account',
        }),
      ).toEqual({ adopted: false });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rename 后崩溃且 db.init 重建空旧目录时，删除空目录并恢复兼容链接', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-restart-layout-'));
    const fixture = legacyFixture(base, 'migration_required');
    const profileId = generateProfileId();
    const isolated = fixture.getProfileDir(profileId);
    writeAdoptionMarker(fixture, fixture.account.id, profileId);
    mkdirSync(dirname(isolated), { recursive: true, mode: 0o700 });
    chmodSync(dirname(isolated), 0o700);
    renameSync(fixture.legacyProfile, isolated);
    // 模拟下一进程先执行 ensureDirectories()。
    mkdirSync(fixture.legacyProfile, { mode: 0o700 });
    try {
      const recovered = adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture, false));
      expect(recovered).toEqual({ adopted: true, profileId });
      expect(lstatSync(fixture.legacyProfile).isSymbolicLink()).toBe(true);
      expect(existsSync(join(fixture.legacyProfile, 'cookie-marker'))).toBe(true);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('已绑定账号的兼容链接目标丢失时保持 migration_required 和 marker', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-dangling-'));
    const fixture = legacyFixture(base, 'migration_required');
    const profileId = generateProfileId();
    const isolated = fixture.getProfileDir(profileId);
    fixture.account.profileId = profileId;
    writeAdoptionMarker(fixture, fixture.account.id, profileId);
    rmSync(fixture.legacyProfile, { recursive: true });
    symlinkSync(relative(dirname(fixture.legacyProfile), isolated), fixture.legacyProfile, 'dir');
    try {
      expect(() => adoptSingleLegacyProfile(fixture.store, adoptionOptions(fixture, false))).toThrow();
      expect(fixture.account.status).toBe('migration_required');
      expect(existsSync(fixture.marker)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('数据库绑定后账号消失时不删除 marker，也不报告迁移成功', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-account-deleted-'));
    const fixture = legacyFixture(base);
    const store = {
      ...fixture.store,
      adoptLegacyProfile: () => true,
      findById: () => null,
    };
    try {
      expect(() => adoptSingleLegacyProfile(store, adoptionOptions(fixture))).toThrow(
        'legacy browser profile could not be bound to account',
      );
      expect(existsSync(fixture.marker)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('账号删除赢得竞态时清理属于该账号的在途 marker 和旧 profile', () => {
    const base = mkdtempSync(join(tmpdir(), 'xhs-legacy-delete-pending-'));
    const fixture = legacyFixture(base);
    const profileId = generateProfileId();
    writeAdoptionMarker(fixture, fixture.account.id, profileId);
    try {
      removeAccountProfile(fixture.account.id, undefined, adoptionOptions(fixture, false).paths);
      expect(existsSync(fixture.marker)).toBe(false);
      expect(existsSync(fixture.legacyProfile)).toBe(false);
      expect(readdirSync(base).some((name) => name.startsWith('browser-profile.removed-'))).toBe(true);
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
      writeAdoptionMarker(fixture, fixture.account.id, profileId);
      expect(() => adoptSingleLegacyProfile(store, adoptionOptions(fixture, false))).toThrow(
        'legacy profile adoption marker requires exactly one account',
      );
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
      adoptLegacyProfile: (id: string, profileId: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated database interruption');
        }
        return fixture.store.adoptLegacyProfile(id, profileId);
      },
    };
    const firstAttempt = adoptionOptions(fixture);
    const recovery = adoptionOptions(fixture, false);
    try {
      expect(() => adoptSingleLegacyProfile(store, firstAttempt)).toThrow('simulated database interruption');
      expect(lstatSync(fixture.legacyProfile).isSymbolicLink()).toBe(true);
      const entriesBefore = readdirSync(join(base, 'browser-profiles'));
      expect(JSON.parse(readFileSync(fixture.marker, 'utf8'))).toMatchObject({
        version: 1,
        accountId: fixture.account.id,
        profileId: entriesBefore[0],
      });

      const recovered = adoptSingleLegacyProfile(store, recovery);
      expect(recovered.adopted).toBe(true);
      expect(fixture.account.status).toBe('active');
      expect(readdirSync(join(base, 'browser-profiles'))).toEqual(entriesBefore);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
