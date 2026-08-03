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

#### P0-1 同机多账号共享硬件指纹

- **现象**：独立 profile 只隔离 Cookie / localStorage / IndexedDB / SW；Canvas、WebGL、AudioContext、字体列表、`hardwareConcurrency`、屏幕/`devicePixelRatio`/`colorDepth`、`MediaDevices.enumerateDevices` 等在同机全账号一致。
- **证据**：`launchPersistentContext` 选项仅有 `headless` / `channel` / `args` / `viewport` / `proxy`（`context.ts:28-36`）；全仓无 per-account `userAgent` / `timezoneId` / `locale` / `geolocation` / `deviceScaleFactor`。
- **平台用法**：设备指纹簇 × 多 UID → 农场连通分量。完整隔离需一容器/一云手机一账号——本 Wave C 只做环境自洽。

#### P0-2 启动参数偏离真实桌面 Chrome

- **证据**：`BROWSER_ARGS`（`constants.ts:10-26`）含 `--no-sandbox`、`--disable-setuid-sandbox`、`--disable-blink-features=AutomationControlled`、`--disable-infobars`、`--deny-permission-prompts` 等。
- **风险**：command-line **真增量**是 no-sandbox / deny-permission-prompts / disable-infobars 等。`AutomationControlled` 与 patchright 默认**重复**（patchright 本就会加），手工再写通常被 Chrome 去重，**不会**比干净 patchright 多出新 flag——删除以免误解即可，勿写成「去掉后 webdriver 更好」。
- `--deny-permission-prompts` 使 Notification/geo 权限态异常，并与后续 C3 `geolocation` 注入冲突（须配合 `grantPermissions` 且先去掉 deny）。

#### P0-3 登录可走 headless + 固定 viewport（条件触发）

- **证据**：`viewport: headless ? { width: 1920, height: 1080 } : null`（`context.ts:32-34`）；`LoginSessionManager.createSession` 透传 `config.browser.headless`（`login-session.ts`）；headless 写门禁**不覆盖** login/read。
- **默认**：出厂 `XHS_MCP_HEADLESS` 未设时为 **false**（有头）。
- **红线触发**：显式 `XHS_MCP_HEADLESS=true`（或调用传入 headless）时，登录建档走 headless + 固定 1920×1080 → `screen≈viewport` 经典异常。

#### P0-4（增补）代理下 WebRTC / ICE 本地 IP 泄漏

- 全仓无 WebRTC 抑制。A1 强制住宅代理后，若 STUN 仍暴露宿主/机房 IP，形成「出口 IP ≠ 真实网络」——比单纯缺 timezone 更致命。须在 Wave C / A1 联调中处理或文档接受风险。

### P1

| ID | 向量 | 证据 | 说明 |
|----|------|------|------|
| P1-1 | 代理未与时区/locale/geo 绑定 | `proxy: { server }` only（`context.ts:35`） | A1 先于 C3 上线会出现「异地 IP + 宿主机 Intl」——比无代理更像农场 |
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

1. 收紧 `BROWSER_ARGS`：默认去掉 no-sandbox / deny-permission-prompts；删重复的 AutomationControlled 行；容器用 env 开 no-sandbox。
2. 登录强制 headful + `viewport: null`；无 DISPLAY 用 Xvfb 或 `ALLOW_HEADLESS_LOGIN`。
3. **C8**：WebRTC/ICE 抑制或书面 `wontfix` + 自检清单；同机共现工程约束。
4. **A1 与 C3+C8 捆绑**：不得长期「有 proxy 无时区 / 未处理 WebRTC」。

### P1

5. 账号级 timezone/locale/geolocation + `grantPermissions`；校验 `navigator.languages` / Accept-Language。
6. evaluate 封装 + `waitForFunction` 主世界等待策略成文 — **done（C6）**。
7. `resolveImagePaths` 对齐 `downloadFile`（proxy + Referer + Sec-Fetch）— **done（C4）**。
8. 登出 = 归档 profile（复用 `profile.ts` 模式）— **done（C5）**。

---

## 5. 检测用例清单（自检）

- [ ] 同机双账号对比 Canvas/WebGL hash
- [ ] `HEADLESS=true` 时登录 viewport 是否 1920×1080
- [ ] 异地代理下 `Intl` / `navigator.languages` 是否仍为宿主机
- [ ] 代理下 WebRTC 候选地址是否暴露宿主 IP
- [x] 发布配图请求是否带与浏览一致的 Referer/Sec-Fetch/Cookie 通道（C4）
- [x] `deleteCookies` 后 profile 内 IndexedDB 是否仍在（C5：原路径应不存在，内容在 `.archived-*`）
- [ ] 去掉 deny 并 grant geolocation 后 `permissions.query` 是否一致

---

## 6. 状态

| 项 | 状态 |
|----|------|
| 审计 | open（review 修订已合入文档） |
| Wave C 整改 | pending |
