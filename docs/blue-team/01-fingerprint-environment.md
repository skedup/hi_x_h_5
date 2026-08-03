# 01 · 浏览器 / 设备指纹 / 环境 / CDP 面

> 角度：平台如何判定「这不是一台正常真人用的 Chrome」。  
> 审计日期：2026-08-03 · 源码实证 · 忽略既有 `docs/blue/`。

---

## 1. 范围与底座

| 项 | 现状 |
|----|------|
| 驱动 | `patchright`（非 playwright） |
| 启动 | `chromium.launchPersistentContext` + `channel: 'chrome'` |
| 隔离 | 每账号 `browser-profiles/{profileId}` |
| 写门禁 | `headlessWriteGate` 默认拒绝 headless 写 |

核心入口：`src/xhs/clients/context.ts` · `constants.ts` · `core/profile.ts` · `core/login-session.ts`。

---

## 2. Detection Vectors

### P0

#### P0-1 同机多账号共享硬件指纹

- **现象**：独立 profile 只隔离 Cookie / localStorage / IndexedDB / SW；Canvas、WebGL、AudioContext、字体列表、`hardwareConcurrency`、屏幕参数在同机全账号一致。
- **证据**：`launchPersistentContext` 选项仅有 `headless` / `channel` / `args` / `viewport` / `proxy`（`context.ts:28-36`）；全仓无 per-account `userAgent` / `timezoneId` / `locale` / `geolocation` / `deviceScaleFactor`。
- **平台用法**：设备指纹簇 × 多 UID → 农场连通分量。

#### P0-2 启动参数偏离真实桌面 Chrome

- **证据**：`BROWSER_ARGS`（`constants.ts:10-26`）含 `--no-sandbox`、`--disable-setuid-sandbox`、`--disable-blink-features=AutomationControlled`、`--disable-infobars`、`--deny-permission-prompts` 等。
- **风险**：command-line 指纹；权限一律拒绝使 Notification/geo 权限态异常。patchright 已处理 AutomationControlled，手工再塞增加差异面。

#### P0-3 登录可走 headless + 固定 viewport

- **证据**：`viewport: headless ? { width: 1920, height: 1080 } : null`（`context.ts:32-34`）；`LoginSessionManager.createSession` 直接用 `config.browser.headless`（`login-session.ts:171-175`）；headless 写门禁**不覆盖** login/read（`multi-account.ts:151-160`）。
- **风险**：登录是设备建档窗口；`screen≈viewport=1920×1080` 是经典组合异常。

### P1

| ID | 向量 | 证据 | 说明 |
|----|------|------|------|
| P1-1 | 代理未与时区/locale/geo 绑定 | `proxy: { server }` only（`context.ts:35`） | IP 属地与 `Intl`/语言不一致 |
| P1-2 | 主世界 `evaluate(..., false)` 大量读 `__INITIAL_STATE__` | content/search/explore/interact/login-session 等 | 功能刚需，但离开 patchright 默认 isolated 路径；`waitForFunction` 默认 main |
| P1-3 | 部分 `evaluate`/`$$eval` 未显式传 world | creator / interact 找评论 / `humanScrollToBottom` 等 | DOM 与状态脚本混用两套 world，策略未统一 |
| P1-4 | 发布配图 Node `fetch` 旁路 | `downloadImageFromUrl`（`utils/index.ts:620+`） | 浏览器 egress（含 proxy）与 Node TLS/IP 分裂；账号下载已走 `APIRequestContext`，发布路径未对齐 |
| P1-5 | `deleteCookies` 只清 Cookie | `context.ts:193-207` | 不清 profile 持久化面；与真人清会话不符 |
| P1-6 | DB `storageState` 与磁盘 profile 双源 | AccountPool 传 `state`，但 launch **不注入** | 真源是 persistent profile；门闩语义易漂移 |

### P2

| ID | 向量 | 说明 |
|----|------|------|
| P2-1 | 文档提 `stealth.js`，仓库中不存在 | 无 `addInitScript` 反而是好事；勿为「有 stealth」去注入 navigator |
| P2-2 | postinstall 装 chromium，运行要系统 Chrome | 版本/路径漂移 |
| P2-3 | 无 per-account 屏参差异化 | 同机 headful 多账号 screen 指纹几乎相同 |
| P2-4 | QR 经 `api.qrserver.com` | 登录侧信道，非主指纹面 |

---

## 3. 已做得好的点

1. patchright + `channel: 'chrome'` + persistent context（官方推荐组合）。
2. `profileId` 缺失 fail-closed，禁止回退共享目录。
3. Headful 时 `viewport: null`，消除 `screen == viewport`。
4. 写操作 headless 门禁默认开。
5. **不伪造 `webId`**，交由平台自然发放。
6. 已剔除 `--disable-notifications`、后台 timer throttling 等自曝 args。
7. 账号下载走 `context.request`（Cookie + proxy 同源）。
8. 登录临时目录 → `finalizeLoginProfile` 转正，避免抢共享 profile。
9. 交互倾向真实 CDP mouse/keyboard（`isTrusted=true`）。

---

## 4. 整改建议

### P0

1. **收紧 `BROWSER_ARGS`**：默认去掉 `--no-sandbox` / `--disable-setuid-sandbox`（仅 CI env 打开）；评估去掉 `--deny-permission-prompts`；AutomationControlled 交给 patchright。
2. **登录强制 headful**：建档阶段禁止固定 1920×1080。
3. **同机共现工程约束**：并发账号上限；强制独立住宅代理；监控同 canvas/WebGL × 多 userId。

### P1

4. 账号级 `timezoneId` / `locale` / `geolocation` 与代理属地对齐并持久化到 DB。
5. 统一 evaluate 策略：读 `__INITIAL_STATE__` → 明确 main；纯 DOM → utility；封装 `$$eval`/`waitForFunction`。
6. `resolveImagePaths` 改走账号 `APIRequestContext`。
7. 登出 = 归档/删除 profile，不只 `clearCookies`。
8. 明确 storage 真源：以磁盘 profile 为准；DB state 仅审计快照。

### P2

9. postinstall 对齐 `patchright install chrome` 或文档锁定 Chrome 版本矩阵。
10. 删除不存在的 stealth 描述；**禁止**随意 `addInitScript` 补丁 navigator。

---

## 5. 检测用例清单（自检）

- [ ] 同机双账号、无代理，对比 Canvas/WebGL hash 是否相同
- [ ] Headless 登录是否仍可走通
- [ ] Headless 时 viewport 是否固定 1920×1080
- [ ] 异地代理下 `Intl` 时区是否仍为宿主机
- [ ] 发布 HTTP 配图时 Node 出口 IP 是否与浏览器一致
- [ ] `deleteCookies` 后 profile 内 localStorage/IndexedDB 是否仍在
- [ ] `Notification` / 权限 API 在默认 args 下是否异常

---

## 6. 状态

| 项 | 状态 |
|----|------|
| 审计 | open |
| Wave C 整改 | pending |
