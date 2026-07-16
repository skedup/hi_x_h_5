# feat/blue_1 反检测对抗工作计划

> 分支：`feat/blue_1`（基于 `master` @ `be45ce4` 切出）
> 来源：蓝军 7 份报告（`docs/blue/01`–`07`）
> 目标：针对报告中**平台可观测的技术信号**做反检测工程化修复；**不**采纳报告中"避免伪造真人行为 / 改人工确认 / 停止自动化"等对外合规口径（内部项目、不做上线）。

## 进度追踪

| 项 | 状态 | 提交 |
|---|---|---|
| **A1** 合成事件替换（4 处） | ✅ 完成 | feat/blue_1（待 commit） |
| **A2** 输入节奏拟人 | ✅ 完成 | feat/blue_1（待 commit） |
| **A3** 来源语义自洽 | ✅ 完成 | feat/blue_1（待 commit） |
| **A4** 固定时钟抖动 | ✅ 完成 | feat/blue_1（待 commit） |
| C1 每账号独立 profile | ⬜ 待做 | — |
| C2 多账号共现抑制 | ⬜ 待做 | — |
| C3 收尾 | ⬜ 待做 | — |
| B1 环境指纹 | ⬜ 待做 | — |
| B2 网络双栈统一 | ⬜ 待做 | — |

---

## 0. 口径与原则

- **采纳**：所有"平台侧可观测信号"及其证据（file:line、动态实测结论）。
- **忽略**：所有"停止自动化 / 人工在环 / fail-closed 不发布 / 不要伪装人类"的道德化结论。
- **反向冲突处理**：蓝军建议"删除 anti-detection 启动参数以求诚实"。反检测目标下**保留** webdriver 隐藏类参数（`--disable-blink-features=AutomationControlled`），只删除"反而制造可观测异常"的参数（如 `--disable-notifications` 使 `Notification` undefined）。
- **验证优先**：每个修复点都配套本地回验（isTrusted 测试页、Referer/Sec-Fetch 检查、指纹一致性），不靠主观判断。

---

## 1. 工作波次总览

| 波次 | 范围 | 信号确定性 | 改动规模 | 回验方式 |
|---|---|---|---|---|
| **A** | T0 合成事件 + T1 输入/来源/时序 | 高（动态实测坐实） | 中（集中 4 文件） | isTrusted 测试页 + 来源一致性 |
| **B** | T2 环境指纹 + T3 网络双栈 | 中高 | 中 | 指纹一致性 + 抓包头比对 |
| **C** | T4 账号隔离 + 多账号共现抑制 + T5 收尾 | 高（架构级） | 大 | 跨 profile 隔离门禁 + 共现率统计 |

> 已确认**多账号场景**，故波次 C 为必做（账号隔离 + 共现抑制是反检测核心，非合规要求）。首版落地顺序：**A → C（隔离先行，否则多账号仍共享设备图谱，A 波输入修复收益被抵消）→ B**。

---

## 2. 波次 A — 确定性页面侧信号（首版必做）

### A1. 替换合成 DOM 事件为可信通道（T0）
**证据**：`04` §2.2/§2.3/§3.4 实测 `isTrusted=false`；Patchright locator/keyboard/setInputFiles 产生 `isTrusted=true`。
| 位置 | 现状 | 修复 |
|---|---|---|
| `src/xhs/clients/services/explore.ts:533-535` | `el.click()` 打开笔记 | `locator.click()` |
| `src/xhs/clients/services/interact.ts:529-534` | `dispatchEvent(new MouseEvent())` 点赞评论 | `locator.click()` |
| `src/xhs/clients/services/interact.ts:315-320` | `textContent + dispatchEvent(input)` 回复 | `.fill()` / 逐字 `keyboard.type()` |
| `src/xhs/clients/services/explore.ts:690-693` | 同上，自动评论 | `.fill()` / 逐字 `keyboard.type()` |

**DOD**：本地测试页对上述 4 处不再出现业务目标上的 `isTrusted=false` click/input。

### A2. 输入节奏拟人（T1-输入）
**证据**：`04` §3.2/§3.3 无 delay `keyboard.type()` 亚毫秒突发；中文路径缺 key/composition 链。
- `interact.ts:220-222`、`publish.ts:154-175`、`publish.ts:449-459`：无 delay `keyboard.type()` → 加逐字可变延迟（40–180ms + 偶发长停顿）。
- `publish.ts:142-145`、`publish.ts:441-444`：`fill()` 整段瞬时标题/长文 → 改逐字 typed 输入。
- 中文输入补 `compositionstart/update/end` 事件链，逼近 IME 形态。

**DOD**：单字符间隔 CV > 0、存在删除/修订、无"整段瞬时出现"。

### A3. 来源语义自洽（T1-来源）
**证据**：`04` §5 深链直开 `xsec_source=pc_feed` 但 Referer 空、`Sec-Fetch-Site:none`，与真实 feed 点击（Referer=`/feed`、`same-origin`）矛盾。
- `interact.ts:190-201`、`content.ts:26-38`、`interact.ts:29-40/110-121/190-202`：保持来源语义一致——
  - 优先走"搜索/feed → 点击结果"的真实站内导航链；
  - 无合法前序曝光时不声明 `pc_feed`，去掉 `xsec_source` 避免相矛盾。

**DOD**：URL source、Referer、Sec-Fetch-Site 三者一致。

### A4. 固定时钟抖动（T1-时序）
**证据**：`03` §P1-1/P1-4 固定 300/500/1000/2000/3000ms 尖峰。
- `config.ts:80-84` `REQUEST_INTERVAL` 固定 2000ms → 变量区间 + 安全下限。
- `explore.ts` / `interact.ts` / `publish.ts` 各处固定 sleep → 抖动化。

**DOD**：事件间隔直方图无离散尖峰。

---

## 3. 波次 B — 环境指纹与网络（待评审）

### B1. 环境指纹（T2）
- **headless 门禁**：`config.ts` 默认 headful，但 `browser.ts:111-115` facade 默认 `headless=true`（`02` P1-3）→ 以 config 为唯一默认源；写操作拒绝 headless。
- **viewport**：headful 改 `viewport:null`（`05` R3 消除 screen==viewport 组合异常）；仅自动化测试保留固定 viewport。
- **启动参数**：保留 `--disable-blink-features=AutomationControlled`；删除 `--disable-notifications`（`05` §7.4 使 `Notification` undefined 异常）；`--disable-background-timer-throttling` 等前台无信号，保留保活。

### B2. 网络双栈统一（T3）
**证据**：`04` §6 Chrome 页面请求带 cookie/Referer/Sec-Fetch，Node `fetch`/`http.get` 直连缺全部会话头、不走账号代理。
- `utils/index.ts:356` `fetch` 下载、`tools/download.ts:76-88/178-274` → 账号相关下载复用同一浏览器会话出口 + 账号代理，至少补齐 `Cookie/Referer/Sec-Fetch-Site/Mode/Dest`。

**DOD**：账号相关请求头/cookie jar/出口 IP 一致（HTTPS/H2 测试环境验证，不在真实平台试探）。

---

## 4. 波次 C — 账号隔离与共现抑制（多账号必做，架构级）

### C1. 每账号独立 profile（T4）
**证据**：`config.ts:169` 单 `browser-profile`、`context.ts:24-30` 共用、`context.ts:90` 未应用 `options.state`；`06` 实证共享 profile 架构；多账号共用即共享 webId/Cookie/设备盐/指纹，形成平台侧强账号关联图。
- `browser-profiles/{内部随机ID}/` 一账号一目录（目录名用内部随机 ID，不用昵称/手机号/userId）；
- `accounts` 表存不可变 `profile_id`，启动校验：accountId↔profileId 一一对应、同 profile 不分配两账号、单进程持有、实际 proxy 策略与账号一致；
- 真正加载账号 `storageState`，或独立 persistent profile；两种模型不混用；
- proxy 与 profile 绑定，禁止同一 profile 跨出口；删除 A 的 Cookie 不影响 B（隔离门禁）；
- 全新 profile 由用户逐个手工重认证，**不复制**旧 profile 的 Cookie/LocalStorage/IndexedDB/ServiceWorker。

**DOD**：A/B profile 的 `web_session`/`webId`/MediaDeviceSalt 互不相等；删 A 的 Cookie 后 B 不受影响；Local Storage origin 数据互相不可见。

### C2. 多账号共现抑制（P0-3 / P0-4 检测向量）
**证据**：`multi-account.ts:233-247` 默认 `Promise.all` 并行；`interaction.ts:225-343` 同 noteId/xsecToken 同时点赞/收藏/同内容评论；`draft.ts:582-602` 同草稿并行发多账号；`publish.ts:97-131` 视频串行但账号间无冷却。平台可观测：ms/秒级窗口内多账号命中同 target、提交完全相同评论/媒体、同 `xsecToken` 跨账号复用。
- **改并行→串行 + 账号间抖动**：多账号写操作顺序执行，账号间插入随机冷却（如 30–120s 变量），消除同步尖峰；
- **`xsecToken` 绑定**：仅允许在获取它的账号与浏览会话内使用，禁止跨账号复用（`03` §P0-3）；
- **中央限额/熔断**：按账号+出口+动作配置小时/日预算、冷却、并发上限（参考 `01` P0-4）；出现验证码/封禁/429/连续失败立即取消队列进入人工；
- **跨账号 target/content/media 去重**：相同 target、正文 hash、媒体 pHash 跨账号硬拦截（避免"同一张图发 10 个号"的强特征）；
- 注：此为反检测工程手段（打破共现/同内容关联），与蓝军"停止自动化"的合规结论无关。

**DOD**：1/5/60 秒窗口内多账号命中同 target 的共现率趋零；跨账号相同评论/媒体哈希复用率为 0。

### C3. 收尾（T5）
- **伪造 webId**：`utils/index.ts:25-32` 随机 32hex 注入 → 让平台自然发放，消除"无发放记录"异常（`02` P0-2）。
- **息屏自保**（`07`）：显示器 asleep / 无人工输入超时时停写，纯稳健性，非检测规避。
- **审计补全**（`01` P2-2）：本地 HTTP 加 bearer token / 读写能力分级，防止本机任意进程触发批量副作用。

---

## 5. 验证与回滚

- **每波独立 commit**，便于单独回滚；A 波先于 B/C 合入并回验。
- **本地回验脚本**：复用蓝军 `04` 的 isTrusted 测试页思路，仅输出布尔/计数/短哈希，不触碰真实账号。
- **回滚**：任一修复导致功能回归（如 locator 找不到元素），回退该文件至 `be45ce4` 对应版本，不整体 revert 分支。
- **不触碰**：`life/state/services/xhs-mcp`（运行时产物，由 kindred bootstrap 重建）；kindred 仓库本身。

## 6. 与 kindred 的同步

- `feat/blue_1` 在 `hi_x_h_5` 开发，合入 fork `master` 后：
  1. 更新 kindred `integrations/xhs-mcp/upstream.env` 的 `XHS_MCP_COMMIT`；
  2. 重算 `patches/manifest.sha256`；
  3. `service.sh migrate-to-fork` 重新 pin + 对新进程 preflight。
- 切流前在本地用 `isTrusted` 测试页回归 A 波修复。
