/**
 * @fileoverview Database access layer for xhs-mcp.
 * Provides a singleton XhsDatabase class that composes all repositories.
 * All database operations are synchronous for simplicity and performance.
 * @module db
 */

import Database from 'better-sqlite3';
import { chmodSync, existsSync } from 'node:fs';
import { paths, ensureDirectories } from '../core/paths.js';
import { SCHEMA_SQL } from './schema.js';

// Import repositories
import {
  AccountRepository,
  ProfileRepository,
  OperationRepository,
  PublishedRepository,
  InteractionRepository,
  DownloadRepository,
  ConfigRepository,
  MyNotesRepository,
  ExploreRepository,
} from './repos/index.js';

// Re-export domain models
export type { Account } from './repos/accounts.js';
export type { AccountProfile } from './repos/profiles.js';
export type { OperationLog, AccountStats } from './repos/operations.js';
export type { MyPublishedNote, MyNotesFilter } from './repos/my-notes.js';
export type { ExploreConfig, ExploreLogEntry, ExploreSessionStats, ExploreSessionResult } from './repos/explore.js';

// Re-export schema types
export type {
  AccountRow,
  AccountProfileRow,
  OperationLogRow,
  PublishedNoteRow,
  InteractionRow,
  DownloadRow,
  ConfigRow,
  NoteDraftRow,
  MyPublishedNoteRow,
} from './schema.js';

/**
 * Database access class for xhs-mcp.
 * Composes all repositories with application-specific methods.
 * Uses WAL mode for better concurrent performance.
 */
export class XhsDatabase {
  private db: Database.Database;

  // Repositories
  readonly accounts: AccountRepository;
  readonly profiles: ProfileRepository;
  readonly operations: OperationRepository;
  readonly published: PublishedRepository;
  readonly interactions: InteractionRepository;
  readonly downloads: DownloadRepository;
  readonly config: ConfigRepository;
  readonly myNotes: MyNotesRepository;
  readonly explore: ExploreRepository;

  /**
   * Create a new database instance.
   * @param dbPath - Path to the SQLite database file
   */
  constructor(dbPath: string = paths.database) {
    process.umask(0o077);
    this.db = new Database(dbPath);
    // Enable WAL mode for better write performance
    this.db.pragma('journal_mode = WAL');
    if (dbPath !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${dbPath}${suffix}`;
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    }
    // Enable foreign key constraints
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('secure_delete = ON');

    // Initialize repositories
    this.accounts = new AccountRepository(this.db);
    this.profiles = new ProfileRepository(this.db);
    this.operations = new OperationRepository(this.db);
    this.published = new PublishedRepository(this.db);
    this.interactions = new InteractionRepository(this.db);
    this.downloads = new DownloadRepository(this.db);
    this.config = new ConfigRepository(this.db);
    this.myNotes = new MyNotesRepository(this.db);
    this.explore = new ExploreRepository(this.db);
  }

  /**
   * Initialize the database schema
   */
  async init(): Promise<void> {
    await ensureDirectories();
    this.db.exec(SCHEMA_SQL);

    const scrubbedRows = this.operations.scrubPayloads();
    if (scrubbedRows > 0) {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    }
    const scrubMarker = 'kindred.operation_history_scrub.v1';
    const scrubComplete = this.config.get<boolean>(scrubMarker) === true;
    if (scrubbedRows === 0 && !scrubComplete) {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    }
    if (!scrubComplete) {
      this.config.set(scrubMarker, true);
    }

    // 数据库迁移：添加新列到 account_profiles 表
    this.migrateAccountProfiles();
    this.migrateAccounts();
    const noteTokenMarker = 'kindred.my_notes_token_scrub.v1';
    const noteTokenScrubComplete = this.config.get<boolean>(noteTokenMarker) === true;
    const scrubbedNoteTokens = this.myNotes.scrubTokens();
    if (scrubbedNoteTokens > 0 || !noteTokenScrubComplete) {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    }
    if (!noteTokenScrubComplete) {
      this.config.set(noteTokenMarker, true);
    }

  }

  /**
   * 迁移 account_profiles 表，添加新字段
   * SQLite 不支持 IF NOT EXISTS，所以需要捕获错误
   */
  private migrateAccountProfiles(): void {
    const migrations = [
      'ALTER TABLE account_profiles ADD COLUMN ip_location TEXT',
      'ALTER TABLE account_profiles ADD COLUMN like_and_collect INTEGER',
      'ALTER TABLE account_profiles ADD COLUMN is_banned BOOLEAN DEFAULT FALSE',
      'ALTER TABLE account_profiles ADD COLUMN ban_code INTEGER',
      'ALTER TABLE account_profiles ADD COLUMN ban_reason TEXT',
    ];

    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch (e: any) {
        // 忽略 "duplicate column name" 错误
        if (!e.message?.includes('duplicate column name')) {
          throw e;
        }
      }
    }
  }

  /**
   * 迁移 accounts 表，添加 profile_id 列（反检测 C1：每账号独立浏览器 profile）。
   * SQLite 不支持 IF NOT EXISTS，所以需要捕获 "duplicate column name" 错误。
   */
  private migrateAccounts(): void {
    const migrations = [
      'ALTER TABLE accounts ADD COLUMN profile_id TEXT',
    ];

    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch (e: any) {
        if (!e.message?.includes('duplicate column name')) {
          throw e;
        }
      }
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  // ============ Generic Query Methods ============

  /**
   * Execute a SQL statement with parameters
   */
  run(sql: string, params: any[] = []): Database.RunResult {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  /**
   * Get a single row from the database
   */
  get(sql: string, params: any[] = []): any {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  /**
   * Get all rows from the database
   */
  all(sql: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }
}

// Singleton instance
let dbInstance: XhsDatabase | null = null;

/**
 * Get the database instance (singleton)
 * Note: This is synchronous and assumes directories already exist.
 * Use initDatabase() for initial setup.
 */
export function getDatabase(): XhsDatabase {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

/**
 * Initialize the database
 */
export async function initDatabase(): Promise<XhsDatabase> {
  if (!dbInstance) {
    await ensureDirectories();
    dbInstance = new XhsDatabase();
    await dbInstance.init();
  }
  return dbInstance;
}
