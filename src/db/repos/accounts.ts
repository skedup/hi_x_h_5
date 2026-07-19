/**
 * @fileoverview Account repository for database operations.
 * @module db/repos/accounts
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { AccountRow } from '../schema.js';

/**
 * Domain model for a Xiaohongshu account.
 */
export interface Account {
  /** Unique identifier (UUID) */
  id: string;
  /** Human-readable account name */
  name: string;
  /** Optional proxy server URL for this account */
  proxy?: string;
  /** Immutable internal profile ID (random UUID) for the isolated browser profile dir */
  profileId?: string;
  /** Playwright storage state (cookies, localStorage) */
  state?: any;
  /** Account status: active, suspended, banned, or migration_required (legacy account awaiting isolated profile binding) */
  status: 'active' | 'suspended' | 'banned' | 'migration_required';
  /** Timestamp of last successful login */
  lastLoginAt?: Date;
  /** Timestamp of last activity */
  lastActiveAt?: Date;
  /** Account creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Account repository - manages account CRUD operations
 */
export class AccountRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new account
   */
  create(name: string, proxy?: string, profileId?: string): Account {
    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO accounts (id, name, proxy, profile_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, name, proxy || null, profileId || null, now, now);

    return {
      id,
      name,
      proxy,
      profileId,
      status: 'active',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  /**
   * Get account by ID
   */
  findById(id: string): Account | null {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE id = ?');
    const row = stmt.get(id) as AccountRow | undefined;
    return row ? this.rowToAccount(row) : null;
  }

  /**
   * Get account by name
   */
  findByName(name: string): Account | null {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE name = ?');
    const row = stmt.get(name) as AccountRow | undefined;
    return row ? this.rowToAccount(row) : null;
  }

  /**
   * Get account by immutable profile ID
   */
  findByProfileId(profileId: string): Account | null {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE profile_id = ?');
    const row = stmt.get(profileId) as AccountRow | undefined;
    return row ? this.rowToAccount(row) : null;
  }

  /**
   * 为尚无 profile_id 的旧账号首次分配（不可变：仅当当前为 NULL 时写入）。
   * 返回 true 表示本次成功绑定，false 表示账号不存在或已经绑定。
   */
  setProfileId(id: string, profileId: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE accounts SET profile_id = ?, updated_at = ? WHERE id = ? AND profile_id IS NULL',
    );
    return stmt.run(profileId, now, id).changes === 1;
  }

  /**
   * 原子接管唯一旧账号的 profile，并恢复 active。
   * IMMEDIATE 事务使账号数量、账号 ID、状态和 profile_id 校验与写入不可被其他进程插入/删除打断。
   */
  adoptLegacyProfile(id: string, profileId: string): boolean {
    const adopt = this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT id, profile_id, status FROM accounts')
        .all() as Array<{ id: string; profile_id: string | null; status: Account['status'] }>;
      if (rows.length !== 1) return false;
      const account = rows[0];
      if (account.id !== id) return false;
      if (account.status !== 'active' && account.status !== 'migration_required') return false;
      if (account.profile_id !== null && account.profile_id !== profileId) return false;

      this.db
        .prepare("UPDATE accounts SET profile_id = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(profileId, new Date().toISOString(), id);
      return true;
    });
    return adopt.immediate();
  }

  /**
   * 原子删除账号并返回删除瞬间绑定的 profile_id，避免异步关闭客户端期间发生迁移而遗漏清理。
   */
  deleteWithProfileId(id: string): { deleted: boolean; profileId?: string } {
    const remove = this.db.transaction(() => {
      const row = this.db.prepare('SELECT profile_id FROM accounts WHERE id = ?').get(id) as
        | { profile_id: string | null }
        | undefined;
      if (!row) return { deleted: false };
      const result = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      return {
        deleted: result.changes === 1,
        ...(row.profile_id ? { profileId: row.profile_id } : {}),
      };
    });
    return remove.immediate();
  }

  /**
   * 蓝军 #1：升级后尚无独立 profile 的旧账号（profile_id IS NULL 且仍 active）强制进入
   * migration_required，拒绝平台操作，直到人工重登录绑定独立 profile。返回受影响行数。
   */
  legacyProfilesRequireMigration(): number {
    const stmt = this.db.prepare(
      "UPDATE accounts SET status = 'migration_required', updated_at = ? WHERE profile_id IS NULL AND status = 'active'",
    );
    return stmt.run(new Date().toISOString()).changes;
  }

  /**
   * Get all accounts
   */
  findAll(): Account[] {
    const stmt = this.db.prepare('SELECT * FROM accounts ORDER BY created_at DESC');
    const rows = stmt.all() as AccountRow[];
    return rows.map((row) => this.rowToAccount(row));
  }

  /**
   * Get active accounts
   */
  findActive(): Account[] {
    const stmt = this.db.prepare("SELECT * FROM accounts WHERE status = 'active' ORDER BY created_at DESC");
    const rows = stmt.all() as AccountRow[];
    return rows.map((row) => this.rowToAccount(row));
  }

  /**
   * Update account state (Playwright cookies)
   */
  updateState(id: string, state: any): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE accounts SET state = ?, last_login_at = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(JSON.stringify(state), now, now, id);
  }

  /**
   * Update account last active time
   */
  touch(id: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE accounts SET last_active_at = ?, updated_at = ? WHERE id = ?');
    stmt.run(now, now, id);
  }

  /**
   * Update account configuration
   */
  updateConfig(
    id: string,
    updates: { name?: string; proxy?: string; status?: 'active' | 'suspended' | 'banned' | 'migration_required' },
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: any[] = [now];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }
    if (updates.proxy !== undefined) {
      sets.push('proxy = ?');
      values.push(updates.proxy || null);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  /**
   * Delete an account
   */
  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM accounts WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  private rowToAccount(row: AccountRow): Account {
    return {
      id: row.id,
      name: row.name,
      proxy: row.proxy || undefined,
      profileId: row.profile_id || undefined,
      state: row.state ? JSON.parse(row.state) : undefined,
      status: row.status,
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : undefined,
      lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
