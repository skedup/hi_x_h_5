/**
 * @fileoverview 统一配置管理模块
 * 通过环境变量控制应用行为，提供类型安全的配置访问
 * @module core/config
 */

import path from 'path';
import os from 'os';
import { parseProxyRequiredMode } from './proxy.js';

/**
 * 日志级别枚举
 */
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

/**
 * 解析布尔环境变量
 * 支持 true/false, 1/0, yes/no
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.toLowerCase().trim();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

/**
 * 解析整数环境变量
 */
function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * 解析 xsecToken 绑定模式（A3：抽成独立函数，便于单测覆盖“env 未设置时默认值”，
 * 不依赖模块加载时的 process.env 快照）。
 */
export function parseXsecMode(value: string | undefined, defaultValue: 'block' | 'warn'): 'block' | 'warn' {
  if (value === 'block' || value === 'warn') return value;
  return defaultValue;
}

/**
 * 解析日志级别
 */
function parseLogLevel(value: string | undefined, defaultValue: LogLevelName): LogLevelName {
  if (value === undefined) return defaultValue;
  const v = value.toLowerCase().trim() as LogLevelName;
  if (['debug', 'info', 'warn', 'error'].includes(v)) return v;
  return defaultValue;
}

/**
 * 应用配置
 * 所有配置项都可通过环境变量覆盖
 */
export const config = {
  /**
   * 服务器配置
   */
  server: {
    /** HTTP 服务端口 (XHS_MCP_PORT) */
    port: parseInteger(process.env.XHS_MCP_PORT, 18060),
    /**
     * 本地 HTTP MCP 鉴权 bearer token（P2-2）。配置后，/mcp 端点要求
     * `Authorization: Bearer <token>`，缺失/不匹配返回 401。未配置则放行（仅依赖 127.0.0.1 绑定）。
     */
    bearerToken: process.env.XHS_MCP_HTTP_BEARER || '',
    /**
     * 只读 scope 的 bearer token。配置后，持该 token 的请求仅允许读工具，
     * 写工具一律 403。用于把"只读观测"与"可写副作用"分成两个本机进程凭证。
     * 注意：readonly token 必须与 bearerToken 不同；若与 bearerToken 相同则视为全量。
     */
    bearerTokenReadonly: process.env.XHS_MCP_HTTP_BEARER_READONLY || '',
    /**
     * 批量写操作确认值（P2-2：批量写单独 capability + 人工确认）。配置后，
     * 多账号写（accounts='all' 或数组长度>1）必须在请求头 `X-Xhs-Write-Confirm`
     * 携带该值，否则 403。未配置则不强求确认（向后兼容）。
     */
    bulkConfirmToken: process.env.XHS_MCP_BULK_CONFIRM || '',
    /**
     * 人工在场确认 challenge 时效（毫秒）。短时有效、消费后轮换（R4 P2 1019839888），
     * 避免长生命周期复用 token 被当成「自动化无法伪造」的强门禁。默认 120000（2 分钟）。
     */
    presenceChallengeTtlMs: parseInteger(process.env.XHS_MCP_PRESENCE_TTL, 120000),
  },

  /**
   * 数据存储配置
   */
  data: {
    /** 数据目录路径 (XHS_MCP_DATA_DIR)，默认 ~/.xhs-mcp */
    dir: process.env.XHS_MCP_DATA_DIR || path.join(os.homedir(), '.xhs-mcp'),
  },

  /**
   * 日志配置
   */
  log: {
    /** 日志级别 (XHS_MCP_LOG_LEVEL): debug | info | warn | error */
    level: parseLogLevel(process.env.XHS_MCP_LOG_LEVEL, 'debug'),
  },

  /**
   * 浏览器配置
   */
  browser: {
    /** 是否使用无头模式 (XHS_MCP_HEADLESS)，默认 false */
    headless: parseBoolean(process.env.XHS_MCP_HEADLESS, false),
    /**
     * 首次接管旧 browser-profile 时由运维显式确认的账号 ID。
     * 未配置时绝不根据“当前只有一个账号”猜测历史共享 profile 的归属。
     */
    legacyProfileAccountId: process.env.XHS_MCP_LEGACY_PROFILE_ACCOUNT_ID?.trim() || '',
    /** 请求间隔（毫秒）(XHS_MCP_REQUEST_INTERVAL)，用于速率限制 */
    requestInterval: parseInteger(process.env.XHS_MCP_REQUEST_INTERVAL, 2000),
    /** 操作完成后是否保持浏览器打开 (XHS_MCP_KEEP_OPEN)，默认 false */
    keepOpen: parseBoolean(process.env.XHS_MCP_KEEP_OPEN, false),
  },

  /**
   * 超时配置（毫秒）
   */
  timeout: {
    /** 页面加载超时 (XHS_MCP_TIMEOUT_PAGE_LOAD) */
    pageLoad: parseInteger(process.env.XHS_MCP_TIMEOUT_PAGE_LOAD, 30000),
    /** 视频上传超时 (XHS_MCP_TIMEOUT_VIDEO_UPLOAD)，默认 5 分钟 */
    videoUpload: parseInteger(process.env.XHS_MCP_TIMEOUT_VIDEO_UPLOAD, 300000),
  },

  /**
   * Gemini AI 配置
   */
  gemini: {
    /** Gemini API Base URL (GEMINI_BASE_URL) */
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    /** Gemini API Key (GEMINI_API_KEY) */
    apiKey: process.env.GEMINI_API_KEY || '',
    /** 图片生成模型 (GEMINI_IMAGE_GENERATE_MODEL) */
    imageGenerateModel: process.env.GEMINI_IMAGE_GENERATE_MODEL || 'gemini-3-pro-image-preview',
    /** 通用模型 (GEMINI_MODEL) */
    model: process.env.GEMINI_MODEL || 'gemini-3-flash',
    /** 分析模型 (GEMINI_ANALYSIS_MODEL) - 用于内容分析、布局规划 */
    analysisModel: process.env.GEMINI_ANALYSIS_MODEL || 'gemini-3.1-pro-preview-high',
  },

  /**
   * 反检测：多账号共现抑制（波次 C / C2）
   * 所有子项均可通过环境变量独立关闭，便于单独回滚。
   */
  antiDetect: {
    /** C2.1 改并行→串行 + 账号间随机抖动 */
    cooccurrence: {
      /** 总开关：开启后多账号写操作改为串行 + 账号间冷却 */
      enabled: parseBoolean(process.env.XHS_MCP_AD_COOCCURRENCE, true),
      /** 是否串行执行（默认 true；false 时退回并行） */
      sequential: true,
      /** 账号间随机冷却区间（毫秒），消除同步尖峰（如 30–120s） */
      interAccountCooldownMs: [30000, 120000] as [number, number],
    },
    /** C2.2 xsecToken 绑定：禁止跨账号复用同一 token */
    xsecTokenBinding: {
      /** 总开关 */
      enabled: parseBoolean(process.env.XHS_MCP_AD_XSEC, true),
      /**
       * block: 跨账号复用直接拦截；warn: 仅告警放行。
       * A3（blue-team）：默认由 warn 收紧为 block —— breaking change，
       * 迁移期可用 `XHS_MCP_AD_XSEC_MODE=warn` 回滚。见 CHANGELOG.md。
       */
      mode: parseXsecMode(process.env.XHS_MCP_AD_XSEC_MODE, 'block'),
    },
    /** C2.3 中央限额/熔断（按账号预算、冷却、连续失败熔断进入人工） */
    quota: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_QUOTA, true),
      /** 每账号每小时动作预算 */
      perAccountHourly: parseInteger(process.env.XHS_MCP_AD_QUOTA_HOURLY, 60),
      /** 每账号每日动作预算 */
      perAccountDaily: parseInteger(process.env.XHS_MCP_AD_QUOTA_DAILY, 300),
      /** 单账号动作后最小冷却（毫秒），叠加在 REQUEST_INTERVAL 之上 */
      cooldownMsAfterAction: parseInteger(process.env.XHS_MCP_AD_QUOTA_COOLDOWN, 5000),
      /** 连续失败达到该次数即熔断进入人工 */
      consecutiveFailuresToTrip: parseInteger(process.env.XHS_MCP_AD_QUOTA_TRIP, 3),
      /** 命中即熔断的验证码/风控关键字（大小写不敏感，匹配 error 或 result） */
      captchaErrorPatterns: (
        process.env.XHS_MCP_AD_QUOTA_PATTERNS
          ? process.env.XHS_MCP_AD_QUOTA_PATTERNS.split(',').map((s) => s.trim()).filter(Boolean)
          : ['验证码', 'captcha', 'verify', '安全验证', '滑块', 'sliding', 'risk', '风控', '429']
      ) as string[],
    },
    /** C2.4 跨账号 content/media 去重（相同评论正文 / 相同媒体硬拦截；同 target 点赞靠串行+冷却缓解时序共现） */
    dedup: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_DEDUP, true),
    },
    /** C3.2 息屏/无人值守自保（07）：写操作需设备在场，显示器 asleep 或长时间无人确认则停写 */
    liveness: {
      /** 总开关；关闭时写操作不受设备在场约束（默认开） */
      enabled: parseBoolean(process.env.XHS_MCP_AD_LIVENESS, true),
      /**
       * 显示器 asleep 检测轮询间隔（毫秒）；仅 darwin 生效，非 darwin 恒判为 awake（放行）以防误杀。
       * 设为 0 可关闭轮询（此时仅靠 idleTimeoutMs 约束）。
       */
      pollIntervalMs: parseInteger(process.env.XHS_MCP_AD_LIVENESS_POLL, 15000),
      /**
       * 无人确认超时（毫秒）：超过该时长无任何工具调用则认为无人值守，停写。
       * 设为 0 关闭（仅靠显示器 asleep 信号）。默认 0 以避免误杀离线批处理；运维可按需开启。
       */
      idleTimeoutMs: parseInteger(process.env.XHS_MCP_AD_LIVENESS_IDLE, 0),
    },
    /** B1 headless 门禁（05/02）：写操作拒绝 headless，强制 headful 以保留设备在场语义 */
    headlessWriteGate: {
      /** 总开关；开启后 config.browser.headless=true 时所有写操作被拒绝（默认开） */
      enabled: parseBoolean(process.env.XHS_MCP_AD_HEADLESS_WRITE_GATE, true),
    },
    /**
     * A1 多账号写出口硬约束（蓝军 plan）。
     * - block（默认）：多账号写批次每账号须有 proxy，且 serverKey（host:port）互异，否则 skip
     * - warn：仅告警放行（迁移期）
     * - off：关闭检查
     * 单账号写默认不强制（威胁模型：单号同机风险低于多号共现）。
     * 环境变量：XHS_MCP_AD_PROXY_REQUIRED=block|warn|off|true|false
     */
    proxyRequired: {
      mode: parseProxyRequiredMode(process.env.XHS_MCP_AD_PROXY_REQUIRED),
    },
    /**
     * A5 共现守卫持久化：committed 去重键 / xsec token 哈希落库，进程重启后仍拦截。
     * - enabled：`XHS_MCP_AD_PERSIST`（默认 true；设 false 仅内存）
     * - ttlMs：行过期时间，默认 30 天；过期在 load/写入时 GC
     */
    persist: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_PERSIST, true),
      ttlMs: parseInteger(process.env.XHS_MCP_AD_PERSIST_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    },
    /**
     * B1 行为重尾延迟：打字/阅读/滚动步间/Interact dwell 用对数正态，打破均匀时钟。
     * 回滚：`XHS_MCP_AD_HEAVY_TAIL=false`（退回窄带均匀抖动）。
     * 功能等待（发布轮询、上传）继续用 `jitteredSleep`；限流继续用 `rateLimitedSleep`。
     */
    heavyTail: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_HEAVY_TAIL, true),
      /** 对数正态 σ；越大右尾越重 */
      sigma: parseFloat(process.env.XHS_MCP_AD_HEAVY_TAIL_SIGMA || '') || 0.45,
      /** 相对 base 的硬上限倍数，防止极端长停 */
      maxMultiplier: parseFloat(process.env.XHS_MCP_AD_HEAVY_TAIL_MAX_MULT || '') || 8,
    },
    /**
     * B2 指针轨迹点击：Bezier 多步 move + hover dwell；默认禁 force。
     * 回滚：`XHS_MCP_AD_TRAJECTORY=false` → 直点。
     */
    trajectory: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_TRAJECTORY, true),
      /** DoD：启用时轨迹步数下限（建议 ≥5） */
      minSteps: parseInteger(process.env.XHS_MCP_AD_TRAJECTORY_MIN_STEPS, 5),
    },
    /**
     * B3 Interact 会话化：goto 后重尾 dwell → ≥1 阅读 scroll → 轨迹 click → 动作后停留。
     * 回滚：`XHS_MCP_AD_INTERACT_SESSION=false` → 跳过入页阅读/滚动与加长后停留（仍保留 B1/B2）。
     */
    interactSession: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_INTERACT_SESSION, true),
      /** 入页后、动作前阅读 dwell 基准 ms */
      preDwellMs: parseInteger(process.env.XHS_MCP_AD_INTERACT_PRE_DWELL_MS, 1500),
      /** 动作后停留基准 ms（DoD 可观测 ≥ 该配置的合理采样下限） */
      postStayMs: parseInteger(process.env.XHS_MCP_AD_INTERACT_POST_STAY_MS, 1200),
      /** 最少阅读滚动次数（humanScroll / wheel） */
      minReadScrolls: parseInteger(process.env.XHS_MCP_AD_INTERACT_MIN_SCROLLS, 1),
    },
    /**
     * B4 Explore 视频接触：按 feed 视频占比打开并 dwell，不再硬跳过全部视频。
     * 回滚：`XHS_MCP_AD_EXPLORE_ALLOW_VIDEO=false` → 退回非视频路径（与旧行为一致）。
     */
    explore: {
      allowVideo: parseBoolean(process.env.XHS_MCP_AD_EXPLORE_ALLOW_VIDEO, true),
    },
    /**
     * B7 alreadyDone 短会话：已赞/已藏等无需点击时，跳过加长 post-stay，改用短 dwell。
     * 回滚：`XHS_MCP_AD_ALREADY_DONE_SHORT=false` → 与真实互动相同 post-stay。
     */
    alreadyDoneShort: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_ALREADY_DONE_SHORT, true),
      /** alreadyDone 路径 post-stay 基准 ms（默认 ~400，远短于 interactSession.postStayMs） */
      postStayMs: parseInteger(process.env.XHS_MCP_AD_ALREADY_DONE_POST_STAY_MS, 400),
    },
    /**
     * B7 导航重试间隔：失败重载用重尾采样，避免 3–5s 均匀连刷同 URL。
     * 回滚：`XHS_MCP_AD_NAV_RETRY_HEAVY_TAIL=false` → 均匀 [3000, 5000] ms。
     */
    navRetryHeavyTail: {
      enabled: parseBoolean(process.env.XHS_MCP_AD_NAV_RETRY_HEAVY_TAIL, true),
    },
  },

  /**
   * 图片处理配置
   */
  imageProcessor: {
    /** 画布预设尺寸 */
    canvasSizes: {
      '1:1': { width: 1080, height: 1080 },
      '3:4': { width: 1080, height: 1440 },
      '4:3': { width: 1440, height: 1080 },
    },
    /** 颜色预设 */
    colorPalettes: {
      minimal: {
        primary: '#1a1a1a',
        secondary: '#666666',
        background: '#ffffff',
        text: '#1a1a1a',
        accent: '#0066ff',
      },
      colorful: {
        primary: '#6366f1',
        secondary: '#8b5cf6',
        background: '#faf5ff',
        text: '#1e1b4b',
        accent: '#f43f5e',
      },
      dark: {
        primary: '#e2e8f0',
        secondary: '#94a3b8',
        background: '#0f172a',
        text: '#f8fafc',
        accent: '#38bdf8',
      },
      light: {
        primary: '#334155',
        secondary: '#64748b',
        background: '#f8fafc',
        text: '#0f172a',
        accent: '#0ea5e9',
      },
    },
  },
} as const;

/**
 * 派生路径（基于 data.dir）
 */
export const paths = {
  /** 数据目录 */
  get dataDir() {
    return config.data.dir;
  },
  /** SQLite 数据库文件 */
  get database() {
    return path.join(config.data.dir, 'data.db');
  },
  /** 旧版单一 Chrome profile；唯一旧账号迁移后保留为指向独立目录的回滚兼容链接 */
  get browserProfile() {
    return path.join(config.data.dir, 'browser-profile');
  },
  /** 每账号独立浏览器 profile 目录（基于内部随机 profile_id，隔离 Cookie/LocalStorage/设备盐） */
  getBrowserProfileDir(profileId: string) {
    return path.join(config.data.dir, 'browser-profiles', profileId);
  },
  /** 下载目录 */
  get downloads() {
    return path.join(config.data.dir, 'downloads');
  },
  /** 图片下载目录 */
  get images() {
    return path.join(config.data.dir, 'downloads', 'images');
  },
  /** 视频下载目录 */
  get videos() {
    return path.join(config.data.dir, 'downloads', 'videos');
  },
  /** QR 码临时目录 */
  get qrcode() {
    return path.join(config.data.dir, 'qrcode');
  },
  /** Prompt 模板目录 */
  get prompts() {
    return path.join(config.data.dir, 'prompts');
  },
  /** 日志目录 */
  get logs() {
    return path.join(config.data.dir, 'logs');
  },
  /** 日志文件 */
  get logFile() {
    return path.join(config.data.dir, 'logs', 'xhs-mcp.log');
  },
  /** 临时文件目录 */
  get temp() {
    return path.join(config.data.dir, 'temp');
  },
  /** 临时图片目录（用于下载 HTTP 图片后上传） */
  get tempImages() {
    return path.join(config.data.dir, 'temp', 'images');
  },
  /** 草稿目录 */
  get drafts() {
    return path.join(config.data.dir, 'drafts');
  },
  /** 草稿输出目录（生成的配图） */
  getDraftOutputPath(draftId: string) {
    return path.join(config.data.dir, 'drafts', draftId);
  },
};

/**
 * 获取笔记图片下载路径
 */
export function getImageDownloadPath(noteId: string): string {
  return path.join(paths.images, noteId);
}

/**
 * 获取笔记视频下载路径
 */
export function getVideoDownloadPath(noteId: string): string {
  return path.join(paths.videos, noteId);
}

/**
 * 打印当前配置（用于调试）
 */
export function printConfig(): void {
  console.error('=== XHS-MCP Configuration ===');
  console.error(`  Server Port: ${config.server.port}`);
  console.error(`  Data Directory: ${config.data.dir}`);
  console.error(`  Log Level: ${config.log.level}`);
  console.error(`  Headless Mode: ${config.browser.headless}`);
  console.error(`  Keep Browser Open: ${config.browser.keepOpen}`);
  console.error(`  Request Interval: ${config.browser.requestInterval}ms`);
  console.error(`  Page Load Timeout: ${config.timeout.pageLoad}ms`);
  console.error(`  Video Upload Timeout: ${config.timeout.videoUpload}ms`);
  console.error(`  Gemini Base URL: ${config.gemini.baseUrl}`);
  console.error(`  Gemini API Key: ${config.gemini.apiKey ? '[SET]' : '[NOT SET]'}`);
  console.error(`  Gemini Image Generate Model: ${config.gemini.imageGenerateModel}`);
  console.error(`  Gemini Model: ${config.gemini.model}`);
  console.error('=============================');
}

// ============ Image Processor 导出 ============
// 为 image-processor 模块提供兼容的导出名

export const GEMINI_CONFIG = {
  baseUrl: config.gemini.baseUrl,
  apiKey: config.gemini.apiKey,
  analysisModel: config.gemini.analysisModel,
  imageModel: config.gemini.imageGenerateModel,
} as const;

export const CANVAS_SIZES = config.imageProcessor.canvasSizes;
export const COLOR_PALETTES = config.imageProcessor.colorPalettes;
export const OUTPUT_DIR = paths.drafts;
