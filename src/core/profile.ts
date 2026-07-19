/**
 * @fileoverview 每账号独立浏览器 profile 目录管理（反检测 C1：账号隔离）。
 * profile_id 为内部随机 UUID，仅用于目录命名，不暴露昵称/手机号/userId。
 * @module core/profile
 */

import { randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { paths } from './config.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LegacyProfileAccount {
  id: string;
  status: 'active' | 'suspended' | 'banned' | 'migration_required';
  profileId?: string;
}

export interface LegacyProfileAccountStore {
  findAll(): LegacyProfileAccount[];
  findById(id: string): LegacyProfileAccount | null;
  setProfileId(id: string, profileId: string): boolean;
  updateConfig(id: string, updates: { status?: LegacyProfileAccount['status'] }): void;
}

interface LegacyProfilePaths {
  legacyProfile: string;
  adoptionMarker: string;
  getProfileDir(profileId: string): string;
}

const defaultLegacyPaths: LegacyProfilePaths = {
  legacyProfile: paths.browserProfile,
  adoptionMarker: `${paths.browserProfile}.adoption.json`,
  getProfileDir: (profileId) => paths.getBrowserProfileDir(profileId),
};

/**
 * 生成不可变 profile_id（内部随机 UUID）。
 */
export function generateProfileId(): string {
  return randomUUID();
}

function readMarker(marker: string): string | undefined {
  if (!existsSync(marker)) return undefined;
  const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { profileId?: unknown };
  if (typeof parsed.profileId !== 'string' || !UUID_PATTERN.test(parsed.profileId)) {
    throw new Error('legacy profile adoption marker is invalid');
  }
  return parsed.profileId;
}

function writeMarker(marker: string, profileId: string): void {
  const fd = openSync(marker, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ profileId })}\n`, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(marker, 0o600);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function validatePrivateProfile(dir: string): void {
  const stats = statSync(dir);
  if (!stats.isDirectory()) throw new Error('legacy browser profile is not a directory');
  if ((stats.mode & 0o777) !== 0o700) throw new Error('legacy browser profile permissions must be 0700');
}

function linkTargetsProfile(link: string, profileDir: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    return resolve(dirname(link), readlinkSync(link)) === resolve(profileDir);
  } catch {
    return false;
  }
}

function profileIdFromCompatibilityLink(pathConfig: LegacyProfilePaths): string | undefined {
  try {
    if (!lstatSync(pathConfig.legacyProfile).isSymbolicLink()) return undefined;
    const target = resolve(dirname(pathConfig.legacyProfile), readlinkSync(pathConfig.legacyProfile));
    const profileId = basename(target);
    if (!UUID_PATTERN.test(profileId) || resolve(pathConfig.getProfileDir(profileId)) !== target) return undefined;
    validatePrivateProfile(target);
    return profileId;
  } catch {
    return undefined;
  }
}

/**
 * 单账号旧部署兼容迁移：只有数据库恰好一个未绑定的 active/migration_required 账号时，
 * 才把旧 browser-profile 原子移动到 UUID 目录。旧路径保留相对符号链接，使部署失败回滚
 * 到旧代码后仍能打开同一 profile。多账号或归属不明确时保持 no-op，随后由调用方 fail-closed。
 *
 * marker + 符号链接共同覆盖进程在文件移动与数据库绑定之间退出的恢复路径；重试会复用
 * 同一个 profileId，不复制 Cookie，也不会生成第二份可并发使用的 Chrome profile。
 */
export function adoptSingleLegacyProfile(
  accounts: LegacyProfileAccountStore,
  pathConfig: LegacyProfilePaths = defaultLegacyPaths,
): { adopted: boolean; profileId?: string } {
  const markerProfileId = readMarker(pathConfig.adoptionMarker);
  const all = accounts.findAll();
  if (all.length !== 1) {
    // 已开始的迁移不能在账号集合变化后被静默忽略，否则会留下未绑定但可继续使用的 profile。
    if (markerProfileId) throw new Error('legacy profile adoption marker requires exactly one account');
    return { adopted: false };
  }
  const account = all[0];

  if (account.profileId) {
    if (!markerProfileId) return { adopted: false };
    if (markerProfileId !== account.profileId) throw new Error('legacy profile adoption marker conflicts with account');
    const profileDir = pathConfig.getProfileDir(account.profileId);
    if (!linkTargetsProfile(pathConfig.legacyProfile, profileDir)) {
      throw new Error('legacy profile compatibility link is missing');
    }
    if (account.status === 'migration_required') accounts.updateConfig(account.id, { status: 'active' });
    unlinkSync(pathConfig.adoptionMarker);
    return { adopted: true, profileId: account.profileId };
  }
  if (account.status !== 'active' && account.status !== 'migration_required') return { adopted: false };

  const linkedProfileId = profileIdFromCompatibilityLink(pathConfig);
  if (markerProfileId && linkedProfileId && markerProfileId !== linkedProfileId) {
    throw new Error('legacy profile adoption state is inconsistent');
  }
  const profileId = markerProfileId ?? linkedProfileId ?? generateProfileId();
  const profileDir = pathConfig.getProfileDir(profileId);

  if (!markerProfileId && !linkedProfileId) {
    if (!pathEntryExists(pathConfig.legacyProfile)) return { adopted: false };
    if (lstatSync(pathConfig.legacyProfile).isSymbolicLink()) {
      throw new Error('legacy browser profile link target is invalid');
    }
    validatePrivateProfile(pathConfig.legacyProfile);
    // ensureDirectories 会为新安装创建空目录；空目录不代表可接管的旧登录态。
    if (readdirSync(pathConfig.legacyProfile).length === 0) return { adopted: false };
  }

  if (!markerProfileId) {
    writeMarker(pathConfig.adoptionMarker, profileId);
  }

  if (!linkedProfileId) {
    if (!pathEntryExists(pathConfig.legacyProfile)) {
      // 进程可能在 rename 与 symlink 之间退出；marker 指向的目标完整时补建兼容链接。
      if (!existsSync(profileDir)) throw new Error('legacy browser profile is missing');
      validatePrivateProfile(profileDir);
      symlinkSync(relative(dirname(pathConfig.legacyProfile), profileDir), pathConfig.legacyProfile, 'dir');
    } else {
      if (lstatSync(pathConfig.legacyProfile).isSymbolicLink()) {
        throw new Error('legacy browser profile link target is invalid');
      }
      validatePrivateProfile(pathConfig.legacyProfile);
      const profileRoot = dirname(profileDir);
      mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
      chmodSync(profileRoot, 0o700);
      if (existsSync(profileDir)) throw new Error('isolated browser profile target already exists');
      renameSync(pathConfig.legacyProfile, profileDir);
      try {
        symlinkSync(relative(dirname(pathConfig.legacyProfile), profileDir), pathConfig.legacyProfile, 'dir');
      } catch (error) {
        renameSync(profileDir, pathConfig.legacyProfile);
        unlinkSync(pathConfig.adoptionMarker);
        throw error;
      }
    }
  }

  const bound = accounts.setProfileId(account.id, profileId);
  const current = accounts.findById(account.id);
  if (!bound && current?.profileId !== profileId) {
    throw new Error('legacy browser profile could not be bound to account');
  }
  if (current?.status === 'migration_required') accounts.updateConfig(account.id, { status: 'active' });
  unlinkSync(pathConfig.adoptionMarker);
  return { adopted: true, profileId };
}

/**
 * 登录会话的专属临时 profile 目录。
 * 每个登录会话使用独立目录，避免多账号并行登录共享同一 profile 的冲突。
 */
export function getLoginProfileDir(sessionId: string): string {
  return paths.getBrowserProfileDir(`_login_${sessionId}`);
}

/**
 * 登录成功后，将临时登录目录转正为该账号的正式 profile 目录。
 * 目录重命名保留 Cookie/LocalStorage/IndexedDB/ServiceWorker 等持久化数据，
 * 符合“全新 profile 由用户人工重认证、不复制旧共享 profile”的语义。
 */
export function finalizeLoginProfile(sessionId: string, profileId: string): void {
  const from = getLoginProfileDir(sessionId);
  const to = paths.getBrowserProfileDir(profileId);
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    // 蓝军 #2：目标 profile 已存在时，先归档旧目录再做原子转正，
    // 使本次重登录得到的 Cookie/storageState 实际生效，且临时目录不再残留。
    const archived = `${to}.archived-${Date.now()}`;
    renameSync(to, archived);
  }
  renameSync(from, to);
}

/**
 * 删除账号的 profile 目录（移除账号时清理隔离数据）。
 */
export function removeProfileDir(profileId: string | undefined): void {
  if (!profileId) return;
  const dir = paths.getBrowserProfileDir(profileId);
  if (existsSync(dir)) {
    renameSync(dir, `${dir}.removed-${Date.now()}`);
  }
  // 单账号旧版兼容链接随账号一并清理，避免留下指向已归档目录的 dangling symlink。
  if (linkTargetsProfile(paths.browserProfile, dir)) unlinkSync(paths.browserProfile);
}
