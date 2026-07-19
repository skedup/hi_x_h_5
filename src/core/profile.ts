/**
 * @fileoverview 每账号独立浏览器 profile 目录管理（反检测 C1：账号隔离）。
 * profile_id 为内部随机 UUID，仅用于目录命名，不暴露昵称/手机号/userId。
 * @module core/profile
 */

import { randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
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
  adoptLegacyProfile(id: string, profileId: string): boolean;
}

interface LegacyProfilePaths {
  legacyProfile: string;
  adoptionMarker: string;
  getProfileDir(profileId: string): string;
}

interface LegacyProfileMarker {
  version: 1;
  accountId: string;
  profileId: string;
}

export interface LegacyProfileAdoptionOptions {
  expectedAccountId?: string;
  paths?: LegacyProfilePaths;
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

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readMarker(marker: string): LegacyProfileMarker | undefined {
  if (!pathEntryExists(marker)) return undefined;
  const stats = lstatSync(marker);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || stats.size > 4096) {
    throw new Error('legacy profile adoption marker is invalid');
  }
  let parsed: Partial<LegacyProfileMarker>;
  try {
    parsed = JSON.parse(readFileSync(marker, 'utf8')) as Partial<LegacyProfileMarker>;
  } catch {
    throw new Error('legacy profile adoption marker is invalid');
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.accountId !== 'string' ||
    parsed.accountId.length === 0 ||
    parsed.accountId.length > 256 ||
    typeof parsed.profileId !== 'string' ||
    !UUID_PATTERN.test(parsed.profileId)
  ) {
    throw new Error('legacy profile adoption marker is invalid');
  }
  return parsed as LegacyProfileMarker;
}

function writeFully(fd: number, value: string): void {
  const buffer = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written === 0) throw new Error('legacy profile adoption marker write made no progress');
    offset += written;
  }
}

/**
 * 先完整落盘临时文件，再用同目录 hard-link 的 EEXIST 语义原子发布最终 marker。
 * 这样并发启动不会覆盖彼此，进程中断也不会留下半截最终 JSON。
 */
function createMarker(markerPath: string, candidate: LegacyProfileMarker): LegacyProfileMarker {
  const temp = `${markerPath}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFully(fd, `${JSON.stringify(candidate)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  let published: LegacyProfileMarker | undefined;
  let publishFailure: unknown;
  try {
    linkSync(temp, markerPath);
    fsyncDirectory(dirname(markerPath));
    published = candidate;
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      publishFailure = error;
    } else {
      try {
        published = readMarker(markerPath);
        if (!published) {
          publishFailure = new Error('legacy profile adoption marker disappeared', { cause: error });
        }
      } catch (readError) {
        publishFailure = readError;
      }
    }
  }

  let cleanupFailure: unknown;
  try {
    unlinkSync(temp);
    fsyncDirectory(dirname(markerPath));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) cleanupFailure = error;
  }
  if (publishFailure) throw publishFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (!published) {
    throw new Error('legacy profile adoption marker was not published');
  }
  return published;
}

function removeMarker(marker: string): void {
  try {
    unlinkSync(marker);
    fsyncDirectory(dirname(marker));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function validatePrivateProfile(dir: string, requireState = false): void {
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) throw new Error('legacy browser profile is not a directory');
  if ((stats.mode & 0o777) !== 0o700) throw new Error('legacy browser profile permissions must be 0700');
  if (requireState && readdirSync(dir).length === 0) throw new Error('legacy browser profile is empty');
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
  if (!pathEntryExists(pathConfig.legacyProfile)) return undefined;
  if (!lstatSync(pathConfig.legacyProfile).isSymbolicLink()) return undefined;
  const target = resolve(dirname(pathConfig.legacyProfile), readlinkSync(pathConfig.legacyProfile));
  const profileId = basename(target);
  if (!UUID_PATTERN.test(profileId) || resolve(pathConfig.getProfileDir(profileId)) !== target) {
    throw new Error('legacy browser profile link target is invalid');
  }
  return profileId;
}

function createCompatibilityLink(pathConfig: LegacyProfilePaths, profileDir: string): void {
  try {
    symlinkSync(relative(dirname(pathConfig.legacyProfile), profileDir), pathConfig.legacyProfile, 'dir');
    fsyncDirectory(dirname(pathConfig.legacyProfile));
  } catch (error) {
    if (!isErrno(error, 'EEXIST') || !linkTargetsProfile(pathConfig.legacyProfile, profileDir)) throw error;
  }
}

/** 将 marker 描述的磁盘状态收敛为“真实私有目录 + 旧路径兼容链接”。 */
function ensureAdoptedProfileLayout(pathConfig: LegacyProfilePaths, profileId: string): void {
  const profileDir = pathConfig.getProfileDir(profileId);
  const linkedProfileId = profileIdFromCompatibilityLink(pathConfig);
  if (linkedProfileId) {
    if (linkedProfileId !== profileId) throw new Error('legacy profile adoption state is inconsistent');
    validatePrivateProfile(profileDir, true);
    return;
  }

  const targetExists = pathEntryExists(profileDir);
  const legacyExists = pathEntryExists(pathConfig.legacyProfile);
  if (targetExists) {
    validatePrivateProfile(profileDir, true);
    if (legacyExists) {
      validatePrivateProfile(pathConfig.legacyProfile);
      if (readdirSync(pathConfig.legacyProfile).length !== 0) {
        throw new Error('legacy profile adoption state is inconsistent');
      }
      // db.init/ensureDirectories 会在 rename 后崩溃的重启中补出这个空目录；安全移除后恢复链接。
      rmdirSync(pathConfig.legacyProfile);
      fsyncDirectory(dirname(pathConfig.legacyProfile));
    }
    createCompatibilityLink(pathConfig, profileDir);
    return;
  }

  if (!legacyExists) throw new Error('legacy browser profile is missing');
  if (lstatSync(pathConfig.legacyProfile).isSymbolicLink()) {
    throw new Error('legacy browser profile link target is invalid');
  }
  validatePrivateProfile(pathConfig.legacyProfile, true);
  const profileRoot = dirname(profileDir);
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  fsyncDirectory(dirname(profileRoot));
  renameSync(pathConfig.legacyProfile, profileDir);
  fsyncDirectory(dirname(pathConfig.legacyProfile));
  fsyncDirectory(profileRoot);
  createCompatibilityLink(pathConfig, profileDir);
}

/**
 * 单账号旧部署兼容迁移：首次接管必须由 expectedAccountId 显式确认归属，并且数据库恰好只有
 * 该未绑定的 active/migration_required 账号，才把旧 browser-profile 原子移动到 UUID 目录。
 * 旧路径保留相对符号链接，使部署失败回滚到旧代码后仍能打开同一 profile。
 *
 * marker + 符号链接共同覆盖进程在文件移动与数据库绑定之间退出的恢复路径；重试会复用
 * 同一个 profileId，不复制 Cookie，也不会生成第二份可并发使用的 Chrome profile。
 */
export function adoptSingleLegacyProfile(
  accounts: LegacyProfileAccountStore,
  options: LegacyProfileAdoptionOptions = {},
): { adopted: boolean; profileId?: string } {
  const pathConfig = options.paths ?? defaultLegacyPaths;
  let marker = readMarker(pathConfig.adoptionMarker);
  const all = accounts.findAll();
  if (all.length !== 1) {
    // 已开始的迁移不能在账号集合变化后被静默忽略，否则会留下未绑定但可继续使用的 profile。
    if (marker) throw new Error('legacy profile adoption marker requires exactly one account');
    return { adopted: false };
  }
  const account = all[0];

  if (marker && marker.accountId !== account.id) {
    throw new Error('legacy profile adoption marker belongs to another account');
  }

  if (account.profileId) {
    if (!marker) return { adopted: false };
    if (account.status !== 'active' && account.status !== 'migration_required') {
      throw new Error('legacy profile adoption account is not eligible');
    }
    if (marker.profileId !== account.profileId) throw new Error('legacy profile adoption marker conflicts with account');
    ensureAdoptedProfileLayout(pathConfig, marker.profileId);
    if (!accounts.adoptLegacyProfile(account.id, marker.profileId)) {
      throw new Error('legacy browser profile could not be bound to account');
    }
    const current = accounts.findById(account.id);
    if (!current || current.profileId !== marker.profileId || current.status !== 'active') {
      throw new Error('legacy browser profile account disappeared during adoption');
    }
    removeMarker(pathConfig.adoptionMarker);
    return { adopted: true, profileId: account.profileId };
  }
  if (account.status !== 'active' && account.status !== 'migration_required') {
    if (marker) throw new Error('legacy profile adoption account is not eligible');
    return { adopted: false };
  }

  const linkedProfileId = profileIdFromCompatibilityLink(pathConfig);
  if (marker && linkedProfileId && marker.profileId !== linkedProfileId) {
    throw new Error('legacy profile adoption state is inconsistent');
  }

  if (!marker && !linkedProfileId) {
    if (!pathEntryExists(pathConfig.legacyProfile)) return { adopted: false };
    if (lstatSync(pathConfig.legacyProfile).isSymbolicLink()) {
      throw new Error('legacy browser profile link target is invalid');
    }
    validatePrivateProfile(pathConfig.legacyProfile);
    // ensureDirectories 会为新安装创建空目录；空目录不代表可接管的旧登录态。
    if (readdirSync(pathConfig.legacyProfile).length === 0) return { adopted: false };
  }

  if (!marker) {
    if (!options.expectedAccountId) {
      throw new Error('legacy profile owner confirmation is required');
    }
    if (options.expectedAccountId !== account.id) {
      throw new Error('legacy profile owner confirmation does not match the only account');
    }
    marker = createMarker(pathConfig.adoptionMarker, {
      version: 1,
      accountId: account.id,
      profileId: linkedProfileId ?? generateProfileId(),
    });
    if (marker.accountId !== account.id) {
      throw new Error('legacy profile adoption marker belongs to another account');
    }
  }

  ensureAdoptedProfileLayout(pathConfig, marker.profileId);
  const bound = accounts.adoptLegacyProfile(account.id, marker.profileId);
  const current = accounts.findById(account.id);
  if (!bound || !current || current.profileId !== marker.profileId || current.status !== 'active') {
    throw new Error('legacy browser profile could not be bound to account');
  }
  removeMarker(pathConfig.adoptionMarker);
  return { adopted: true, profileId: marker.profileId };
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
function removeProfileDirAt(profileId: string | undefined, pathConfig: LegacyProfilePaths): void {
  if (!profileId) return;
  const dir = pathConfig.getProfileDir(profileId);
  if (existsSync(dir)) {
    renameSync(dir, `${dir}.removed-${Date.now()}`);
    fsyncDirectory(dirname(dir));
  }
  // 单账号旧版兼容链接随账号一并清理，避免留下指向已归档目录的 dangling symlink。
  if (linkTargetsProfile(pathConfig.legacyProfile, dir)) {
    unlinkSync(pathConfig.legacyProfile);
    fsyncDirectory(dirname(pathConfig.legacyProfile));
  }
}

export function removeProfileDir(profileId: string | undefined): void {
  removeProfileDirAt(profileId, defaultLegacyPaths);
}

/**
 * 删除账号时同时消费属于它的在途旧 profile 迁移，避免账号已删除后遗留 marker 阻断后续启动。
 */
export function removeAccountProfile(
  accountId: string,
  profileId: string | undefined,
  pathConfig: LegacyProfilePaths = defaultLegacyPaths,
): void {
  const markerPath = pathConfig.adoptionMarker;
  const marker = readMarker(markerPath);
  if (!marker || marker.accountId !== accountId) {
    removeProfileDirAt(profileId, pathConfig);
    return;
  }
  if (profileId && profileId !== marker.profileId) {
    throw new Error('legacy profile adoption marker conflicts with deleted account');
  }

  removeProfileDirAt(marker.profileId, pathConfig);
  if (pathEntryExists(pathConfig.legacyProfile) && !lstatSync(pathConfig.legacyProfile).isSymbolicLink()) {
    validatePrivateProfile(pathConfig.legacyProfile);
    renameSync(pathConfig.legacyProfile, `${pathConfig.legacyProfile}.removed-${Date.now()}`);
    fsyncDirectory(dirname(pathConfig.legacyProfile));
  }
  removeMarker(markerPath);
}
