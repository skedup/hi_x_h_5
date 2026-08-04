# 01 · 浏览器 / 设备指纹 / 环境 / CDP 面

> 角度：平台如何判定「这不是一台正常真人用的 Chrome」。  
> 审计日期：2026-08-03 · 源码实证 · 忽略既有 `docs/blue/`。  
> Review： [指纹 review](1600ce01-1923-47b5-a075-6f4f0114d87c) `request-changes` → 本修订已吸收。

---

## 1. 范围与底座

| 项 | 现状 |
|----|------|
| 驱动 | `patchright`（非 playwright） |
| 启动 | `chromium.launchPersistentContext` + `channel: 'chrome'` |
| 隔离 | 每账号 `browser-profiles/{profileId}`（Cookie/存储；**非**硬件指纹） |
| 写门禁 | `headlessWriteGate` 默认拒绝 headless 写 |
| headless 默认 | `config.browser.headless` **默认 `false`** |

核心入口：`src/xhs/clients/context.ts` · `constants.ts` · `core/profile.ts` · `core/login-session.ts`。

> **术语**：代码注释中的「设备指纹盐」指 profile 目录内持久化站点标识（Cookie/本地存储等），**不是** Canvas/WebGL 等硬件指纹隔离。勿据此认为同机多号已解关联。

---

## 2. Detection Vectors

### P0

#### P0-1 同机多账号共享硬件指纹 — **residual（D4 / 基建）**

- **现象**：独立 profile 只隔离 Cookie / localStorage / IndexedDB / SW；Canvas、WebGL、AudioContext、字体列表、`hardwareConcurrency`、屏幕/`devicePixelRatio`/`colorDepth`、`MediaDevices.enumerateDevices` 等在同机全账号一致。
- **证据**：`launchPersistentContext` 以 profile + proxy + locale 选项为主；无 per-account Canvas/WebGL 盐。
- **平台用法**：设备指纹簇 × 多 UID → 农场连通分量。完整隔离需一容器/一云手机一账号——**Wave C 不做硬件隔离**。
- **环境侧已缓解**：C3 账号级 timezone/locale/geo；C8 WebRTC prefs——见下，不等于解关联硬件指纹。

#### P0-2 启动参数偏离真实桌面 Chrome — **mitigated（C1）**

- **原证据**：`BROWSER_ARGS` 曾含 `--no-sandbox`、`--deny-permission-prompts`、重复 AutomationControlled 等。
- **现状**：默认收紧；容器用 `XHS_MCP_BROWSER_NO_SANDBOX` 显式开启。见 [C1-BROWSER-ARGS.md](./C1-BROWSER-ARGS.md)。

#### P0-3 登录可走 headless + 固定 viewport — **mitigated（C2）**

- **默认**：登录强制 headful + `viewport: null`（有图形）；`XHS_MCP_ALLOW_HEADLESS_LOGIN` 为逃生口。见 [C2-LOGIN-HEADFUL.md](./C2-LOGIN-HEADFUL.md)。
- **运维自检**：显式允许 headless 登录时仍可能出现固定 viewport——勿在生产开逃生口。

#### P0-4（增补）代理下 WebRTC / ICE 本地 IP 泄漏 — **mitigated（C8）**

- 有 proxy 时 prefs `webrtc.ip_handling_policy=disable_non_proxied_udp`（默认开）。见 [C8-WEBRTC.md](./C8-WEBRTC.md)。残余：特定 Chrome 通道仍可能泄漏 → 威胁模型接受 / env 回滚。

### P1

| ID | 向量 | 证据 | 说明 |
|----|------|------|------|
| P1-1 | 代理未与时区/locale/geo 绑定 | 曾仅 `proxy.server` | **mitigated（C3）**；运维须 `set_account_config` 补齐属地 |
| P1-2 | 主世界 `evaluate(..., false)` 读 `__INITIAL_STATE__` | 多 service | **mitigated（C6）**：`evalMainState` / `waitForMainState`；裸 `waitForFunction` 读状态已收敛 |
| P1-3 | 部分 `evaluate`/`$$eval` 未显式传 world | creator / interact / utils | **mitigated（C6）**：DOM 路径走 `evalDom` / `waitForDom`；标准见 C6-EVAL-WORLD |
| P1-4 | 发布配图 Node `fetch` 旁路 | `downloadImageFromUrl`（经 `downloadFile`） | **mitigated（C4）**：配图走账号 `APIRequestContext` + Referer/Sec-Fetch；Gemini 理解拉图仍为服务端侧 `fetch`（非浏览 egress） |
| P1-5 | `deleteCookies` 只清 Cookie | `context.ts` / `archiveProfileDir` | **mitigated（C5）**：登出归档整个 profile；`clearCookies` 语义 deprecated |
| P1-6 | DB `storageState` 与磁盘 profile 双源 | AccountPool 传 `state`，launch **不注入** | 真源是 persistent profile |

### P2

| ID | 向量 | 说明 |
|----|------|------|
| P2-1 | 文档提 `stealth.js`，仓库中不存在 | 无 `addInitScript` 反而是好事 |
| P2-2 | postinstall 装 chromium，运行要系统 Chrome | 版本/路径漂移；`CLAUDE.md` 仍可能写错 headless 默认 |
| P2-3 | 无 per-account 屏参 / 字体 / Audio 等差异化 | 同机共现边 |
| P2-4 | QR 经 `api.qrserver.com` | 登录侧信道 |

---

## 3. 已做得好的点

1. patchright + `channel: 'chrome'` + persistent context。
2. `profileId` 缺失 fail-closed。
3. Headful 时 `viewport: null`。
4. 写操作 headless 门禁默认开。
5. **不伪造 `webId`**。
6. 已剔除 `--disable-notifications`、后台 timer throttling 等。
7. 账号下载走 `context.request`（Cookie + proxy 同源）+ 部分 Sec-Fetch。
8. 登录临时目录 → `finalizeLoginProfile` 转正。
9. 交互走 CDP Input（`isTrusted=true`）；explore 仍有 `force: true`（行为面另册）。

---

## 4. 整改建议

### P0

1. 收紧 `BROWSER_ARGS` — **done（C1）**。
2. 登录强制 headful + `viewport: null` — **done（C2）**；无 DISPLAY 用 Xvfb 或 `ALLOW_HEADLESS_LOGIN`。
3. **C8**：WebRTC/ICE — **mitigated**（prefs；见 [C8-WEBRTC.md](./C8-WEBRTC.md)）；同机共现工程约束仍属基建。
4. **A1 与 C3+C8 捆绑**：代码已接线；运维须为地理代理账号补齐 `timezoneId`/`locale`。

### P1

5. 账号级 timezone/locale/geolocation + `grantPermissions` — **mitigated（C3）**；见 [C3-LOCALE-ENV.md](./C3-LOCALE-ENV.md)。
6. evaluate 封装 + `waitForFunction` 主世界等待策略成文 — **done（C6）**。
7. `resolveImagePaths` 对齐 `downloadFile`（proxy + Referer + Sec-Fetch）— **done（C4）**。
8. 登出 = 归档 profile（复用 `profile.ts` 模式）— **done（C5）**。

---

## 5. 检测用例清单（自检）

- [ ] 同机双账号对比 Canvas/WebGL hash（**D4 residual**，代码不消）
- [ ] `ALLOW_HEADLESS_LOGIN=true` 且 `HEADLESS=true` 时登录 viewport 是否仍异常（逃生口自检，默认路径已强制 headful）
- [x] 异地代理下 `Intl` / `navigator.languages`：经 C3 `timezoneId`/`locale` 配置后应与账号属地一致（见 [C3-LOCALE-ENV.md](./C3-LOCALE-ENV.md)）
- [x] 代理下 WebRTC：prefs `disable_non_proxied_udp`（C8）；手工 ICE 自检见 [C8-WEBRTC.md](./C8-WEBRTC.md)
- [x] 发布配图请求是否带与浏览一致的 Referer/Sec-Fetch/Cookie 通道（C4）
- [x] `deleteCookies` 后 profile 内 IndexedDB 是否仍在（C5：原路径应不存在，内容在 `.archived-*`）
- [x] 去掉 deny 并 grant geolocation 后（C1+C3）：配置 geo 的账号启动时会 `grantPermissions`

---

## 6. 状态

| 项 | 状态 |
|----|------|
| 审计 | closed（P0 可缓解项已标 mitigated；P0-1 硬件共现仍 residual） |
| Wave C 整改 | **done**（C1–C8）；同机硬件指纹共现 → D4 / 运维约束 |
