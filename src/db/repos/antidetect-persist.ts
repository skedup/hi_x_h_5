/**
 * @fileoverview A5 共现守卫持久化仓库：committed 去重键与 xsecToken 哈希。
 * @module db/repos/antidetect-persist
 */

import Database from 'better-sqlite3';
import type { AdDedupKeyRow, AdXsecTokenRow } from '../schema.js';

/**
 * 蓝军 A5：仅持久化已提交（committed）状态；in-flight 仍在内存。
 */
export class AntidetectPersistRepository {
  constructor(private db: Database.Database) {}

  upsertDedup(dedupKey: string, accountId: string, createdAt: number, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO ad_dedup_keys (dedup_key, account_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dedup_key) DO UPDATE SET
           account_id = excluded.account_id,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(dedupKey, accountId, createdAt, expiresAt);
  }

  upsertToken(tokenHash: string, accountId: string, createdAt: number, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO ad_xsec_tokens (token_hash, account_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           account_id = excluded.account_id,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(tokenHash, accountId, createdAt, expiresAt);
  }

  /** 加载未过期的去重键 */
  loadActiveDedups(nowMs: number): AdDedupKeyRow[] {
    return this.db
      .prepare(
        `SELECT dedup_key, account_id, created_at, expires_at
         FROM ad_dedup_keys WHERE expires_at > ?`,
      )
      .all(nowMs) as AdDedupKeyRow[];
  }

  /** 加载未过期的 token 哈希 */
  loadActiveTokens(nowMs: number): AdXsecTokenRow[] {
    return this.db
      .prepare(
        `SELECT token_hash, account_id, created_at, expires_at
         FROM ad_xsec_tokens WHERE expires_at > ?`,
      )
      .all(nowMs) as AdXsecTokenRow[];
  }

  /** 删除已过期行，返回删除条数 */
  deleteExpired(nowMs: number): number {
    const d = this.db.prepare(`DELETE FROM ad_dedup_keys WHERE expires_at <= ?`).run(nowMs);
    const t = this.db.prepare(`DELETE FROM ad_xsec_tokens WHERE expires_at <= ?`).run(nowMs);
    return (d.changes ?? 0) + (t.changes ?? 0);
  }

  /** 清空全部持久化守卫状态（测辅 / 运维） */
  clearAll(): void {
    this.db.exec(`DELETE FROM ad_dedup_keys; DELETE FROM ad_xsec_tokens;`);
  }
}
