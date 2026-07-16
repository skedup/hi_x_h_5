/**
 * @fileoverview 每账号独立浏览器 profile 目录管理（反检测 C1：账号隔离）。
 * profile_id 为内部随机 UUID，仅用于目录命名，不暴露昵称/手机号/userId。
 * @module core/profile
 */

import { randomUUID } from 'crypto';
import { existsSync, renameSync } from 'node:fs';
import { paths } from './config.js';

/**
 * 生成不可变 profile_id（内部随机 UUID）。
 */
export function generateProfileId(): string {
  return randomUUID();
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
}
