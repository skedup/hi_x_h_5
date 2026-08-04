# Xiaohongshu MCP Server

## Project Overview

A Model Context Protocol (MCP) server that provides tools for interacting with Xiaohongshu (小红书/RedNote). Uses Playwright for browser automation. **Version 2.0 adds multi-account support with SQLite database storage.**

## Tech Stack

- **Runtime**: Bun (also compatible with Node.js)
- **Language**: TypeScript (ESNext, strict mode)
- **Browser Automation**: Playwright
- **HTTP Framework**: Hono (for HTTP transport mode)
- **Database**: SQLite (better-sqlite3)
- **MCP**: @modelcontextprotocol/sdk
- **Validation**: Zod v4

## Project Structure

```
~/.xhs-mcp/                   # Data directory
├── data.db                   # SQLite database (accounts, logs, etc.)
├── logs/                     # Log files
│   └── xhs-mcp.log           # Application log
├── prompts/                  # Account prompt files (new in v2.5)
│   └── {accountName}_{accountId}/
│       ├── persona.txt       # Character definition
│       ├── select.txt        # Note selection prompt
│       └── comment.txt       # Comment generation prompt
├── temp/                     # Temporary files
│   └── images/               # Downloaded HTTP images for publishing
└── downloads/
    ├── images/{noteId}/
    └── videos/{noteId}/

src/
├── index.ts                  # Entry point with stdio/http mode switch
├── server.ts                 # MCP Server configuration and tool registration
├── http-server.ts            # HTTP transport server (StreamableHTTP)
├── core/
│   ├── config.ts             # Unified configuration with environment variables
│   ├── paths.ts              # Path utilities (re-exports from config)
│   ├── logger.ts             # Structured logging (console + file)
│   ├── account-pool.ts       # Multi-account client pool (池化管理)
│   ├── account-lock.ts       # Concurrent access prevention (互斥锁)
│   ├── multi-account.ts      # Multi-account operation helpers (并行/串行执行)
│   ├── login-session.ts      # Multi-step login session manager
│   ├── gemini.ts             # Gemini AI integration (image generation, etc.)
│   ├── explore-ai.ts         # AI decision module for explore (note selection, comment generation)
│   ├── prompt-manager.ts     # Prompt file management (read/write/render with LiquidJS)
│   ├── image-upload.ts       # Image upload utilities
│   ├── qrcode-utils.ts       # QR code generation and display utilities
│   └── prompts/              # AI prompt templates
│       └── defaults.ts       # Default prompt templates (persona, select, comment)
├── db/
│   ├── index.ts              # XhsDatabase class (组合所有 Repository)
│   ├── schema.ts             # Table definitions
│   └── repos/                # Repository 模式 - 按实体分离数据访问
│       ├── index.ts          # Repository 导出
│       ├── accounts.ts       # AccountRepository - 账户 CRUD
│       ├── profiles.ts       # ProfileRepository - 用户资料
│       ├── operations.ts     # OperationRepository - 操作日志
│       ├── published.ts      # PublishedRepository - 发布记录
│       ├── interactions.ts   # InteractionRepository - 互动记录
│       ├── downloads.ts      # DownloadRepository - 下载记录
│       ├── config.ts         # ConfigRepository - 配置键值对
│       ├── my-notes.ts       # MyNotesRepository - 我的已发布笔记缓存
│       └── explore.ts        # ExploreRepository - 探索会话和日志
├── tools/
│   ├── account.ts            # xhs_list_accounts, xhs_add_account, xhs_check_login_session, xhs_remove_account, xhs_set_account_config, xhs_get/set_account_prompt
│   ├── auth.ts               # xhs_check_auth_status (+account parameter, syncs profile)
│   ├── content.ts            # xhs_search, xhs_get_note, xhs_user_profile, xhs_list_feeds (+account parameter)
│   ├── publish.ts            # xhs_publish_content, xhs_publish_video (+account/accounts parameter)
│   ├── interaction.ts        # xhs_like_feed, xhs_favorite_feed, xhs_post_comment, xhs_reply_comment, xhs_like_comment, xhs_delete_cookies (+account/accounts)
│   ├── stats.ts              # xhs_get_account_stats, xhs_get_operation_logs
│   ├── download.ts           # xhs_download_images, xhs_download_video
│   ├── draft.ts              # xhs_create_draft, xhs_list_drafts, xhs_publish_draft, etc.
│   ├── creator.ts            # xhs_get_my_notes, xhs_query_my_notes
│   ├── notification.ts       # xhs_get_notifications
│   └── explore.ts            # xhs_explore (自动浏览)
└── xhs/
    ├── index.ts              # XhsClient facade class (supports account options)
    ├── types.ts              # TypeScript interfaces
    ├── clients/
    │   ├── browser.ts        # BrowserClient - Facade 组合所有服务
    │   ├── context.ts        # BrowserContextManager - 共享浏览器上下文
    │   ├── constants.ts      # 常量定义 (TIMEOUTS, DELAYS, SCROLL_CONFIG)
    │   └── services/         # 组合模式 - 按功能分离服务
    │       ├── index.ts      # 服务导出
    │       ├── auth.ts       # AuthService - 登录认证
    │       ├── search.ts     # SearchService - 搜索功能
    │       ├── content.ts    # ContentService - 内容获取
    │       ├── publish.ts    # PublishService - 发布功能
    │       ├── interact.ts   # InteractService - 互动功能
    │       ├── creator.ts    # CreatorService - 创作者中心
    │       ├── notification.ts # NotificationService - 通知获取
    │       └── explore.ts    # ExploreService - 自动浏览
    └── utils/
        └── index.ts          # Utilities (sleep, humanScroll, generateWebId)
```

## Available MCP Tools

### Account Management (New in v2.0)
| Tool | Description |
|------|-------------|
| `xhs_list_accounts` | List all registered accounts with status |
| `xhs_add_account` | Start login process, returns sessionId and QR code URL |
| `xhs_check_login_session` | Check login session status after QR scan (may need verification) |
| `xhs_check_auth_status` | Check if existing account is logged in (syncs profile to DB) |
| `xhs_submit_verification` | Submit SMS verification code (if required) |
| `xhs_remove_account` | Remove an account and its data |
| `xhs_set_account_config` | Update proxy or status for an account |
| `xhs_get_account_prompt` | Get prompt file (persona/select/comment) for an account |
| `xhs_set_account_prompt` | Update prompt file for an account |

### Multi-Step Login Flow

Login is now a multi-step process for better control:

```
1. xhs_add_account                → Returns { sessionId, qrCodeUrl, status: 'waiting_scan' }
   ↓
2. User scans QR code
   ↓
3. xhs_check_login_session(sessionId) → Returns status:
   - 'waiting_scan': Not scanned yet, call again
   - 'scanned': Processing, call again
   - 'verification_required': Need SMS code → call xhs_submit_verification
   - 'success': Login complete, account created
   - 'expired': QR expired (2 min), start over
   ↓
4. xhs_submit_verification(sessionId, code) → If verification needed
   - Code expires in 1 minute
   - Returns 'success' or error
```

Each response includes `nextAction` field guiding the next step.

QR code is generated via api.qrserver.com - works remotely without local file access.

### Content Query
| Tool | Description |
|------|-------------|
| `xhs_search` | Search notes with filters (supports `account` param) |
| `xhs_get_note` | Get note details including comments (supports `describeImages` for AI analysis) |
| `xhs_user_profile` | Get user profile and published notes |
| `xhs_list_feeds` | Get homepage recommended feeds |

### Publishing
| Tool | Description |
|------|-------------|
| `xhs_publish_content` | Publish image/text note (supports HTTP URLs for images, auto-downloads) |
| `xhs_publish_video` | Publish video note (supports `account`/`accounts` params) |

### Interaction
| Tool | Description |
|------|-------------|
| `xhs_like_feed` | Like/unlike a note (supports `account`/`accounts` params) |
| `xhs_favorite_feed` | Favorite/unfavorite a note |
| `xhs_post_comment` | Post a comment on a note |
| `xhs_reply_comment` | Reply to a comment |
| `xhs_like_comment` | Like/unlike a comment |
| `xhs_delete_cookies` | Delete saved cookies/session for an account（C5：归档 on-disk profile，非仅 clearCookies） |

### Statistics (New in v2.0)
| Tool | Description |
|------|-------------|
| `xhs_get_account_stats` | Get operation statistics for an account |
| `xhs_get_operation_logs` | Query operation history |

### Download (New in v2.0)
| Tool | Description |
|------|-------------|
| `xhs_download_images` | Download all images from a note |
| `xhs_download_video` | Download video from a note |

### Draft & AI Generation (New in v2.1)
| Tool | Description |
|------|-------------|
| `xhs_generate_image` | Generate image using Gemini AI (supports style, mood, lighting, etc.) |
| `xhs_create_draft` | Create a note draft with title, content, tags, images |
| `xhs_list_drafts` | List all drafts (optionally include published) |
| `xhs_get_draft` | Get draft details by ID |
| `xhs_update_draft` | Update draft title, content, tags, or images |
| `xhs_delete_draft` | Delete a draft and its associated images |
| `xhs_publish_draft` | Publish a draft to one or multiple accounts |

### Creator Center (New in v2.2)
| Tool | Description |
|------|-------------|
| `xhs_get_my_notes` | Fetch published notes from creator center and cache to database |
| `xhs_query_my_notes` | Query cached notes from database with multi-field filter support |

### Notifications (New in v2.3)
| Tool | Description |
|------|-------------|
| `xhs_get_notifications` | Get notifications (mentions, likes, connections) with info for replying |

### Explore (New in v2.4)
| Tool | Description |
|------|-------------|
| `xhs_explore` | Automated browsing with AI note selection, probability-based liking/commenting |

### Prompt System (New in v2.5)

Each account has customizable prompts stored in `~/.xhs-mcp/prompts/{accountName}_{accountId}/`:
- `persona.txt` - Character/style definition (e.g., "美食博主，喜欢探店")
- `select.txt` - AI note selection prompt template (uses `{{ persona }}`, `{{ notes }}`)
- `comment.txt` - AI comment generation template (uses `{{ persona }}`, `{{ title }}`, `{{ content }}`)

Prompts are auto-initialized with defaults on first explore. Use LiquidJS (Jinja2-style) templating.

## Multi-Account Usage

All operation tools support `account` (single) or `accounts` (multiple) parameters:

```typescript
// Single account
xhs_search({ keyword: "美食", account: "main" })

// Multiple accounts
xhs_like_feed({ noteId: "xxx", xsecToken: "yyy", accounts: ["acc-1", "acc-2"] })

// All active accounts
xhs_publish_content({ title: "...", content: "...", images: [...], accounts: "all" })
```

If no account is specified and only one account exists, it will be used automatically.

## Environment Variables

All configuration can be controlled via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `XHS_MCP_PORT` | `18060` | HTTP server port |
| `XHS_MCP_DATA_DIR` | `~/.xhs-mcp` | Data directory path |
| `XHS_MCP_LOG_LEVEL` | `debug` | Log level: debug, info, warn, error |
| `XHS_MCP_HEADLESS` | `false` | 浏览器无头模式；默认有头。写操作在 `XHS_MCP_AD_HEADLESS_WRITE_GATE=true`（默认）且 headless 时被拒绝；登录见 `XHS_MCP_ALLOW_HEADLESS_LOGIN` |
| `XHS_MCP_ALLOW_HEADLESS_LOGIN` | `false` | C2 登录 headless 逃生口；`false` 时 add_account 强制 headful + viewport:null；见 `docs/blue-team/C2-LOGIN-HEADFUL.md` |
| `XHS_MCP_BROWSER_NO_SANDBOX` | `false` | 容器/CI 回滚：追加 `--no-sandbox`；见 `docs/blue-team/C1-BROWSER-ARGS.md` |
| `XHS_MCP_LEGACY_PROFILE_ACCOUNT_ID` | - | 首次接管旧 `browser-profile` 时显式确认其所属账号 ID |
| `XHS_MCP_KEEP_OPEN` | `false` | 操作完成后保持浏览器打开，用于调试 |
| `XHS_MCP_REQUEST_INTERVAL` | `2000` | Request interval in ms (rate limiting) |
| `XHS_MCP_TIMEOUT_PAGE_LOAD` | `30000` | Page load timeout in ms |
| `XHS_MCP_TIMEOUT_VIDEO_UPLOAD` | `300000` | Video upload timeout in ms (5 min) |
| `XHS_MCP_AD_COOCCURRENCE` | `true` | C2.1 多账号写串行 + 账号间冷却；`false` 退回并行 |
| `XHS_MCP_AD_XSEC` | `true` | C2.2 xsecToken 跨账号复用绑定 |
| `XHS_MCP_AD_XSEC_MODE` | `block` | xsec 绑定模式：`block`/`warn` |
| `XHS_MCP_AD_QUOTA` | `true` | C2.3 中央限额/熔断 |
| `XHS_MCP_AD_QUOTA_HOURLY` | `60` | 每账号每小时动作预算 |
| `XHS_MCP_AD_QUOTA_DAILY` | `300` | 每账号每日动作预算 |
| `XHS_MCP_AD_QUOTA_COOLDOWN` | `5000` | 单账号动作后最小冷却 ms |
| `XHS_MCP_AD_QUOTA_TRIP` | `3` | 连续失败熔断阈值 |
| `XHS_MCP_AD_DEDUP` | `true` | C2.4 跨账号 content/media 去重 |
| `XHS_MCP_AD_LIVENESS` | `true` | 息屏/无人值守写门禁；`false` 关闭 |
| `XHS_MCP_AD_LIVENESS_POLL` | `15000` | 显示器 asleep 轮询间隔 ms（darwin） |
| `XHS_MCP_AD_LIVENESS_IDLE` | `0` | 无人确认超时 ms；`0` 关闭 |
| `XHS_MCP_AD_HEADLESS_WRITE_GATE` | `true` | B1 写操作拒绝 headless；`false` 关闭 |
| `XHS_MCP_AD_PROXY_REQUIRED` | `block` | 多账号写出口门禁：`block`/`warn`/`off`；见 `docs/blue-team/A1-PROXY-RUNBOOK.md` |
| `XHS_MCP_AD_WEBRTC_MITIGATION` | `true` | C8 代理会话写 `webrtc.ip_handling_policy=disable_non_proxied_udp`；`false` 关闭；见 `docs/blue-team/C8-WEBRTC.md` |
| `XHS_MCP_AD_PERSIST` | `true` | A5 共现守卫 committed 落库；`false` 仅内存 |
| `XHS_MCP_AD_PERSIST_TTL_MS` | `2592000000` | 持久化行 TTL（默认 30 天） |
| `XHS_MCP_AD_HEAVY_TAIL` | `true` | B1 行为重尾延迟；`false` 退回窄带均匀；见 `docs/blue-team/B1-CALL-SITES.md` |
| `XHS_MCP_AD_HEAVY_TAIL_SIGMA` | `0.45` | B1 对数正态 σ |
| `XHS_MCP_AD_HEAVY_TAIL_MAX_MULT` | `8` | B1 相对 base 的硬上限倍数 |
| `XHS_MCP_AD_TRAJECTORY` | `true` | B2 指针轨迹点击；`false` 退回直点 |
| `XHS_MCP_AD_TRAJECTORY_MIN_STEPS` | `5` | B2 轨迹步数下限 |
| `XHS_MCP_AD_INTERACT_SESSION` | `true` | B3 Interact 会话化；`false` 跳过入页阅读/滚动与加长后停留；见 `docs/blue-team/B3-CALL-SITES.md` |
| `XHS_MCP_AD_INTERACT_PRE_DWELL_MS` | `1500` | B3 入页阅读 dwell 基准 ms |
| `XHS_MCP_AD_INTERACT_POST_STAY_MS` | `1200` | B3 动作后停留基准 ms |
| `XHS_MCP_AD_INTERACT_MIN_SCROLLS` | `1` | B3 最少阅读滚动次数 |
| `XHS_MCP_AD_EXPLORE_ALLOW_VIDEO` | `true` | B4 Explore 视频接触；`false` 硬跳过视频（旧行为）；见 `docs/blue-team/B4-CALL-SITES.md` |
| `XHS_MCP_AD_NAV_RETRY_HEAVY_TAIL` | `true` | B7 导航失败重试用重尾间隔；`false` 退回均匀 3–5s；见 `docs/blue-team/B7-CALL-SITES.md` |
| `XHS_MCP_AD_ALREADY_DONE_SHORT` | `true` | B7 已赞/已藏等 alreadyDone 路径用短 post-stay；`false` 与真实互动相同；见 `docs/blue-team/B7-CALL-SITES.md` |
| `XHS_MCP_AD_ALREADY_DONE_POST_STAY_MS` | `400` | B7 alreadyDone 短 post-stay 基准 ms |
| `XHS_MCP_AD_TYPING_MODE` | `direct` | B5 键入模式：`direct`（码点 type+revise）或 `ime`（wontfix，降级 direct）；见 `docs/blue-team/B5-IME.md` |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Gemini API base URL |
| `GEMINI_API_KEY` | - | Gemini API key (for future AI features) |
| `GEMINI_IMAGE_GENERATE_MODEL` | `gemini-3-pro-image` | Gemini image generation model |
| `GEMINI_MODEL` | `gemini-3-flash` | Gemini general model |

## Key Commands

```bash
# Development
bun run dev              # Watch mode with auto-reload

# Build
bun run build            # Build to dist/

# Run
bun run start            # Start MCP server (stdio transport)
bun run start:http       # Start MCP server (HTTP transport on port 18060)

# Testing
bun run test:login       # Test login flow
bun run test:search <keyword>  # Test search
bun run test:note <noteId>     # Test get note
```

## Transport Modes

### stdio (default)
Standard MCP stdio transport for use with Claude Desktop and other MCP clients.

```bash
bun run start
```

### HTTP (StreamableHTTP)
HTTP transport for web-based clients and custom integrations.

```bash
bun run start:http              # Default port 18060 (uses node runtime)
bun run start:bun:http          # Use bun runtime for HTTP mode
bun run start:http --port 8080  # Custom port
```

Endpoints:
- `POST /mcp` - MCP protocol endpoint
- `GET /health` - Health check
- `GET /` - Server info

## Important Files

- `~/.xhs-mcp/data.db` - SQLite database with accounts, sessions, operation logs
- `~/.xhs-mcp/logs/xhs-mcp.log` - Application log file (structured logging)
- `~/.xhs-mcp/downloads/` - Downloaded images and videos

## Database Schema

Key tables (通过 Repository 类访问):
- `accounts` - Account info, proxy config, session state (JSON) → `db.accounts.*`
- `account_profiles` - Cached user profile info → `db.profiles.*`
- `operation_logs` - All operation history with timing and results → `db.operations.*`
- `published_notes` - Record of published content → `db.published.*`
- `interactions` - Like/favorite/comment history → `db.interactions.*`
- `downloads` - Download records → `db.downloads.*`
- `config` - Key-value configuration → `db.config.*`
- `note_drafts` - AI-generated drafts for publishing → accessed via `src/tools/draft.ts`
- `my_published_notes` - Cached notes from creator center → `db.myNotes.*`

## Architecture Notes

1. **Browser 层 - 组合模式**:
   - `BrowserContextManager` 管理共享的 browser/context/page
   - 独立服务类 (`AuthService`, `SearchService`, etc.) 接收 context manager
   - `BrowserClient` 作为 Facade 组合所有服务，对外暴露统一 API
   - 完全类型安全，无 `(this as any)` 类型断言

2. **Database 层 - Repository 模式**:
   - 每个实体一个 Repository 类 (`AccountRepository`, `ProfileRepository`, etc.)
   - `XhsDatabase` 组合所有 Repository，提供统一入口
   - 调用语义清晰：`db.accounts.findById()`, `db.operations.log()`, etc.
   - 所有操作同步执行 (better-sqlite3)

3. **Multi-Account**: AccountPool manages multiple XhsClient instances, each with its own session
4. **Session Persistence**: Login state stored in SQLite database, loaded per-account
5. **Account Locking**: Prevents concurrent operations on the same account (FIFO queue)
6. **Operation Logging**: All operations are logged with timing and results
7. **Structured Logging**: Uses `createLogger()` from `core/logger.ts`, outputs to stderr and file
8. **Data Extraction**: Uses `window.__INITIAL_STATE__` from page (Vue state)
9. **xsecToken**: Required for reliable note access - obtained from search results
10. **Dual Transport**: Supports both stdio (default) and HTTP transport modes
11. **Configurable Constants**: Timeouts, delays, and limits defined in constant objects (`TIMEOUTS`, `SEARCH_DEFAULTS`, `SCROLL_CONFIG`, `DELAYS`)
12. **Environment Configuration**: All major settings controllable via environment variables (see `core/config.ts`)

## AI Image Generation Style Reference

**推荐风格：Jean Jullien**

如需使用 Jean Jullien 风格，请在 prompt 开头手动加上 "Illustration by Jean Jullien"（代码不会自动添加）。

风格特点：
- 粗黑笔刷描边
- 扁平色块，配色简单（黑白 + 1-2个点缀色）
- 笨拙呆萌的角色造型（不要强调"可爱"）
- deadpan 表情的幽默感
- 简单但有表现力

## Development Guidelines

- All source in `src/`, compiled output in `dist/`
- Use absolute imports with `.js` extension (e.g., `'./xhs/index.js'`)
- Handle Vue reactive objects (`_rawValue`, `_value`, `.value`)
- Respect rate limits - configurable via `XHS_MCP_REQUEST_INTERVAL` (default 2s)
- Default browser mode is headful (`XHS_MCP_HEADLESS` unset → `false`); write operations rejected when headless + `XHS_MCP_AD_HEADLESS_WRITE_GATE=true` (default)
- All database operations are synchronous (better-sqlite3)
- Login is **headful by default** (ignores `XHS_MCP_HEADLESS` unless `XHS_MCP_ALLOW_HEADLESS_LOGIN=true`); see `docs/blue-team/C2-LOGIN-HEADFUL.md`
- Use `createLogger('module-name')` for logging instead of `console.error/log`
- Extract magic numbers to constant objects with Chinese comments
- All code comments should be in Chinese for consistency

### Browser 层开发
- 新功能添加到对应的 Service 类 (如 `services/search.ts`)
- Service 通过 `this.ctx` 访问浏览器上下文
- `BrowserClient` 只做方法代理，不包含业务逻辑
- 禁止使用 `(this as any)` 类型断言

### Database 层开发
- 新表操作添加到对应的 Repository 类 (如 `repos/accounts.ts`)
- 使用 `db.{repository}.{method}()` 调用方式
- Repository 方法命名规范: `find*`, `create`, `update*`, `delete`, `record`, `log`
