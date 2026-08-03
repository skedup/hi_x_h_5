/**
 * @fileoverview Shared browser context manager for composition pattern.
 * All service classes receive this context to access browser/context/options.
 * @module xhs/clients/context
 */

import { chromium, Browser, BrowserContext, Page } from 'patchright';
import type { APIRequestContext } from 'patchright';
import { LoginUserInfo, FullUserProfile } from '../types.js';
import { createLogger } from '../../core/logger.js';
import { config, paths, assertDisplayAvailableForHeadful } from '../../core/config.js';
import { parseProxyConfig, toPlaywrightProxy } from '../../core/proxy.js';
import { archiveProfileDir } from '../../core/profile.js';
import { getBrowserArgs } from './constants.js';

// Create logger for browser module
export const log = createLogger('browser');

/** launchProfileContext 可选参数（C2 登录强制 headful 等） */
export interface LaunchProfileContextOptions {
  /** 强制 headful，忽略 headless 参数（登录路径用） */
  forceHeadful?: boolean;
}

/**
 * Launch a persistent Chrome profile context rooted at the given directory.
 * 每个账号应使用独立的 profileDir（基于内部随机 profile_id），以隔离
 * Cookie / localStorage / IndexedDB / ServiceWorker / 设备指纹盐。
 * @param profileDir 持久化 user-data-dir 路径
 * @param proxy 账号 proxy 字符串（URL 或 JSON，见 core/proxy.ts）；支持认证
 */
export async function launchProfileContext(
  profileDir: string,
  headless = config.browser.headless,
  proxy?: string,
  options?: LaunchProfileContextOptions,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const effectiveHeadless = options?.forceHeadful ? false : headless;
  if (!effectiveHeadless) {
    assertDisplayAvailableForHeadful();
  }

  const parsedProxy = parseProxyConfig(proxy);
  if (proxy?.trim() && !parsedProxy) {
    log.warn('账号 proxy 无法解析，将不使用代理启动', { proxyPreview: proxy.slice(0, 32) });
  }
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: effectiveHeadless,
    channel: 'chrome',
    args: getBrowserArgs(),
    // B1（05 R3）：headful 时 viewport 置 null，消除 screen==viewport 的组合异常指纹；
    // headless（自动化测试）保留固定 viewport。
    viewport: effectiveHeadless ? { width: 1920, height: 1080 } : null,
    ...(parsedProxy ? { proxy: toPlaywrightProxy(parsedProxy) } : {}),
  });
  const browser = context.browser();
  if (!browser) {
    await context.close();
    throw new Error('Persistent Chrome context has no browser instance.');
  }

  const cookies = await context.cookies();
  // C3.1（02 P0-2）：不再伪造 webId。平台会在正常页面流程中通过响应 Cookie 自然发放；
  // 客户端随机值缺少服务端发放记录，反而形成强反作弊特征。缺失时保持为空，交由平台
  // 首访补发——不 fail-closed 阻断（正常导航即补发），仅记录提示供运维观察。
  if (!cookies.some((cookie) => cookie.name === 'webId')) {
    log.debug('webId 缺失，将交由平台在正常页面流程中自然发放（不伪造）');
  }
  return { browser, context };
}

/**
 * Options for BrowserClient initialization
 */
export interface BrowserClientOptions {
  /** Account ID for this client instance */
  accountId?: string;
  /** Immutable internal profile ID for the isolated browser profile dir */
  profileId: string;
  /** Playwright storage state (cookies, localStorage) as JSON object */
  state?: any;
  /** Proxy server URL (bound to the profile) */
  proxy?: string;
  /** Callback to save state when it changes */
  onStateChange?: (state: any) => void | Promise<void>;
}

type ProfileContextLauncher = typeof launchProfileContext;

/**
 * Shared browser context manager.
 * Encapsulates browser lifecycle and provides shared access to browser/context.
 * All service classes receive an instance of this class.
 */
export class BrowserContextManager {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  options: BrowserClientOptions;
  private readonly launchContext: ProfileContextLauncher;
  private closing = false;

  constructor(options: BrowserClientOptions, launchContext: ProfileContextLauncher = launchProfileContext) {
    this.options = options;
    this.launchContext = launchContext;
  }

  /**
   * 浏览器上下文的 APIRequestContext（B2 下载出口统一）。
   * 经由它的请求继承上下文的 Cookie 与代理出口，与页面请求 egress 一致。
   * 未初始化时返回 null。
   */
  get request(): APIRequestContext | null {
    return this.context?.request ?? null;
  }

  /**
   * Get the current account ID
   */
  get accountId(): string | undefined {
    return this.options.accountId;
  }

  /**
   * Initialize browser with optional headless mode
   * Defaults to config.browser.headless (controlled by XHS_MCP_HEADLESS env)
   */
  async init(headless = config.browser.headless): Promise<void> {
    // 每账号独立 profile 目录（反检测 C1：账号隔离硬不变量）。
    // R4 P0 1019900603：profileId 为空时拒绝回退共享目录（fail-closed），
    // 避免升级后旧账号（profile_id=NULL）仍共享同一 browserProfile，造成多账号串号/Cookie/设备盐强关联。
    // 全新登录由 login-session 使用独立临时目录（getLoginProfileDir），不依赖此共享路径。
    if (!this.options.profileId) {
      throw new Error(
        'isolated profileId required to launch browser context; refusing to fall back to shared profile directory',
      );
    }
    const profileDir = paths.getBrowserProfileDir(this.options.profileId);
    const session = await this.launchContext(profileDir, headless, this.options.proxy);
    this.browser = session.browser;
    this.context = session.context;
    session.context.on('close', () => this.clearClosedSession(session.browser, session.context));
    session.browser.on('disconnected', () => this.clearClosedSession(session.browser, session.context));
  }

  /**
   * Close browser and cleanup resources
   */
  async close(): Promise<void> {
    const browser = this.browser;
    const context = this.context;
    if (!browser) {
      this.context = null;
      return;
    }
    this.closing = true;
    try {
      await browser.close();
    } finally {
      this.clearClosedSession(browser, context);
      this.closing = false;
    }
  }

  /**
   * Ensure context is initialized, initializing if needed
   * Defaults to config.browser.headless (which respects DEBUG env)
   */
  async ensureContext(headless = config.browser.headless): Promise<BrowserContext> {
    if (this.browser && !this.browser.isConnected()) {
      this.clearClosedSession(this.browser, this.context);
    }
    if (!this.context || !this.browser) {
      await this.init(headless);
    }
    return this.context!;
  }

  private clearClosedSession(browser: Browser, context: BrowserContext | null): void {
    if (this.browser !== browser && this.context !== context) return;
    if (this.browser === browser) this.browser = null;
    if (this.context === context) this.context = null;
    if (!this.closing) {
      log.warn('Browser context closed; the next request will reopen the persistent profile');
    }
  }

  /**
   * Create a new page from the current context
   */
  async newPage(): Promise<Page> {
    const context = await this.ensureContext();
    return context.newPage();
  }

  /**
   * Extract current user info from page's __INITIAL_STATE__.user.userInfo
   */
  async extractUserInfo(page: Page): Promise<LoginUserInfo | null> {
    try {
      const result = await page.evaluate(
        () => {
          const state = (window as any).__INITIAL_STATE__;
          if (!state?.user?.userInfo) return null;

          const userInfo = state.user.userInfo;
          // Handle Vue reactive objects
          const data = userInfo._value || userInfo._rawValue || userInfo;

          if (!data || !data.userId) return null;

          return {
            userId: data.userId,
            redId: data.redId || '',
            nickname: data.nickname || '',
            desc: data.desc || '',
            gender: data.gender || 0,
            avatar: data.images || '',
            avatarLarge: data.imageb || '',
          };
        },
        null,
        false,
      );

      if (result) {
        log.info('Extracted user info', { userId: result.userId, nickname: result.nickname });
      }
      return result;
    } catch (e) {
      log.error('Failed to extract user info', { error: e });
      return null;
    }
  }

  /**
   * 登出：关闭浏览器并归档 on-disk profile（C5）。
   *
   * @deprecated 旧实现仅 `context.clearCookies()`，profile 内 IndexedDB 等仍保留。
   * 现改为归档整个 profile 目录；请勿再依赖「只清 Cookie」语义。
   */
  async deleteCookies(): Promise<{ success: boolean; archivedPath?: string | null; error?: string }> {
    try {
      // 须先关闭，再 rename profile，避免 Chrome 文件锁
      await this.close();
      const archivedPath = archiveProfileDir(this.options.profileId);
      this.options.state = undefined;
      log.info('登出已归档 profile', {
        profileId: this.options.profileId,
        archived: Boolean(archivedPath),
      });
      return { success: true, archivedPath };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Save current storage state and notify via callback
   */
  async saveState(): Promise<any> {
    if (!this.context) return null;

    const state = await this.context.storageState();
    this.options.state = state;

    if (this.options.onStateChange) {
      await this.options.onStateChange(state);
    }

    return state;
  }

  /**
   * 访问用户主页，提取完整的用户资料信息
   * 包括基础信息、统计数据、封禁状态等
   *
   * @param userId - 用户 ID
   * @returns 完整的用户资料，或 null（如果获取失败）
   */
  async extractFullUserProfile(userId: string): Promise<FullUserProfile | null> {
    const page = await this.newPage();

    try {
      const url = `https://www.xiaohongshu.com/user/profile/${userId}`;
      log.info('Fetching full user profile', { userId, url });

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // 等待 __INITIAL_STATE__ 加载
      await page.waitForFunction(() => (window as any).__INITIAL_STATE__ !== undefined, {
        timeout: 30000,
      });

      // 等待用户数据加载
      await page
        .waitForFunction(
          () => {
            const state = (window as any).__INITIAL_STATE__;
            const userPageData = state?.user?.userPageData;
            const basicInfo = userPageData?._rawValue?.basicInfo || userPageData?.basicInfo;
            return basicInfo?.nickname;
          },
          { timeout: 10000 },
        )
        .catch(() => {});

      // 提取完整用户信息
      const result = await page.evaluate(
        (uid: string) => {
          const state = (window as any).__INITIAL_STATE__;
          if (!state?.user) return null;

          const user = state.user;
          const userPageData = user.userPageData;
          const bannedInfo = user.bannedInfo;

          // 处理 Vue 响应式对象
          const extract = (obj: any) => {
            if (!obj) return null;
            if (obj._rawValue !== undefined) return obj._rawValue;
            if (obj._value !== undefined) return obj._value;
            return obj;
          };

          const pageData = extract(userPageData);
          const banned = extract(bannedInfo);

          if (!pageData?.basicInfo) return null;

          const basicInfo = pageData.basicInfo;
          const interactions = pageData.interactions || [];

          // 解析 interactions 数组
          const statsMap: Record<string, string> = {};
          for (const item of interactions) {
            if (item?.type) {
              statsMap[item.type] = item.count || '0';
            }
          }

          return {
            // 基础信息
            userId: uid,
            redId: basicInfo.redId || '',
            nickname: basicInfo.nickname || '',
            avatar: basicInfo.images || basicInfo.image || '',
            description: basicInfo.desc || '',
            gender: basicInfo.gender || 0,
            ipLocation: basicInfo.ipLocation || '',

            // 统计数据
            followers: parseInt(statsMap['fans'] || '0', 10),
            following: parseInt(statsMap['follows'] || '0', 10),
            likeAndCollect: parseInt(statsMap['interaction'] || '0', 10),

            // 封禁状态
            isBanned: banned?.serverBanned || false,
            banCode: banned?.code || 0,
            banReason: banned?.reason || '',
          };
        },
        userId,
        false,
      );

      if (result) {
        log.info('Extracted full user profile', {
          userId: result.userId,
          nickname: result.nickname,
          followers: result.followers,
          isBanned: result.isBanned,
        });
      }

      return result;
    } catch (e) {
      log.error('Failed to extract full user profile', { userId, error: e });
      return null;
    } finally {
      await page.close();
    }
  }
}
