# 实施计划 · 蓝军整改（依据 `docs/blue-team/`）

> **用途**：后续按本 plan 分波次实施与验收。  
> **依据**：[README](./README.md) · [01 指纹](./01-fingerprint-environment.md) · [02 行为](./02-behavior-authenticity.md) · [03 关联](./03-multi-account-association.md)  
> **原则**：先做能切断关联图的 Wave A，再做人感行为 Wave B，最后补环境指纹 Wave C；每项有 DoD、触及文件、回滚开关。  
> **状态约定**：`todo` → `doing` → `done` / `wontfix`（改本表，勿另开状态文件）。

---

## 0. 全局约束

| 约束 | 说明 |
|------|------|
| 不改 MCP 工具对外必填契约（除非该项明确写「breaking」） | 新增约束用 env 开关 + 默认收紧；迁移期可 `warn` |
| 反检测与运维门禁分轨 | liveness / headlessWriteGate 保持；本 plan 不把它们当「拟人完成」 |
| 每 Wave 可独立合入 | Wave 内按编号顺序；跨 Wave 依赖见 §5 |
| 测试 | 改守卫/多账号：补 `antidetect.test.ts` / `multi-account.test.ts`；行为原语：尽量单测分布与轨迹接口 |
| 文档 | 项完成后在对应 `01/02/03` 文档把向量标 `mitigated`，并链 PR |

---

## Wave A — 关联与出口（优先，上量生死线）

**目标**：切断「同 IP / 同 note 共现 / 同文案 / 共享 xsec / 重启丢守卫」五类强边。  
**预计触及**：`config.ts` · `antidetect.ts` · `multi-account.ts` · `tools/interaction.ts` · `tools/publish.ts` · `explore.ts` · `explore-ai.ts` · `db/*` · `context.ts`（proxy 形态）

### A1 · 代理硬约束 + 认证 proxy 形态

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 03 P0-2 · README Wave A.1 |
| **做什么** | ① 扩展账号 proxy 配置：支持 Playwright `{ server, username?, password? }`（DB 可存 JSON 或 `user:pass@host` 规范化）。② 写路径（`capability=write`）在 `executeWithAccount` / `executeWithMultipleAccounts` 入口校验：目标账号缺 proxy → skip/`proxy_required`。③ 同一规范化 `server`（或同 host:port）被 ≥2 个**本次写批次**账号使用 → 拒绝多余账号（或整批拒绝，二选一写清）。④ env：`XHS_MCP_AD_PROXY_REQUIRED` 默认 `true`；单账号写可暂允许无 proxy（文档标明风险），`accounts.length>1` 或 `all` 强制有互异 proxy。 |
| **触及文件** | `src/core/config.ts` · `src/core/multi-account.ts` · `src/db/schema.ts` + migration · `src/db/repos/accounts.ts` · `src/xhs/clients/context.ts` · `src/tools/account.ts`（set config 校验） |
| **DoD** | 双账号无 proxy / 同 proxy 写 like → 被拦并返回明确 `skipped` reason；认证 proxy 能传入 `launchPersistentContext`；单测覆盖校验分支 |
| **回滚** | `XHS_MCP_AD_PROXY_REQUIRED=false` |

### A2 · 互动目标跨账号 dedupKey

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 03 P0-3 · README Wave A.2 |
| **做什么** | 为 `xhs_like_feed` / `xhs_favorite_feed` / `xhs_like_comment` 传入：`like:note:${noteId}` · `fav:note:${noteId}` · `like_c:${noteId}:${commentId}`。unlike/unfavorite 是否占用同一键：建议**占用同一键**（防 A 赞 B 立刻踩），或分 `unlike:` 前缀——实现时选一并写进注释。 |
| **触及文件** | `src/tools/interaction.ts`（及 draft/publish 若有类似空洞） |
| **DoD** | 两账号串行 like 同一 note：第二账号 `cross_account_dedup`；现有评论/发布 SHA 去重不受影响 |
| **回滚** | `XHS_MCP_AD_DEDUP=false`（既有总开关） |

### A3 · xsec 默认 block + explore 提取绑定

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 03 P0-4 · P1-8 · README Wave A.3 |
| **做什么** | ① `config.antiDetect.xsecTokenBinding.mode` 默认改为 `'block'`（env 仍可 `warn`）。② `ExploreService.getFeeds`（或主循环拿到 feeds 后）对每条 `xsecToken` 调 `bindXsecSource(token, accountId)`。③ 确认 search / list_feeds 已 bind（回归不回退）。 |
| **触及文件** | `src/core/config.ts` · `src/xhs/clients/services/explore.ts` · 相关测试 |
| **DoD** | 默认配置下账号 B 用账号 A 提取的 token 写 → `xsec_token_bound_to_other_account`；explore 打开后 token 已 committed |
| **回滚** | `XHS_MCP_AD_XSEC_MODE=warn` |

### A4 · 去掉固定评论 fallback + 正文去重对齐

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 03 P0-5 · 02 P1-5 · README Wave A.4 |
| **做什么** | ① `generateComment` 失败/解析失败返回 `{ comment: null }` 或抛可识别错误；调用方（explore + 工具若有）**跳过评论**，禁止 `'很棒的分享！'`。② explore 评论 `dedupKey` 改为至少含正文：`comment_text:${sha256OfText(content)}`（可保留 note 维双键：`explore:comment:${noteId}:${sha}`）。③ `selectLikeTarget` 解析失败改为 `target: 'none'`，禁止默认 `'post'`。 |
| **触及文件** | `src/core/explore-ai.ts` · `src/xhs/clients/services/explore.ts` · 默认 prompt 文档若提及 fallback |
| **DoD** | mock Gemini 失败时会话 `notesCommented` 不增加且无该固定句；同文案跨帖第二账号被拦 |
| **回滚** | 无开关——禁止恢复固定句；仅可通过修 AI 成功率 |

### A5 · CooccurrenceGuard 持久化

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 03 P0-6 · README Wave A.5 |
| **做什么** | ① 新表（或 config/kv）：`ad_dedup_keys(key, owner_account_id, committed_at)` · `ad_xsec_tokens(token_hash, owner_account_id, committed_at)`（token 存 hash，防日志泄漏）。② `beforeAction`/`afterAction`/`bindXsecSource` 读写 DB；进程内存作缓存。③ `reset()` 仅测用，可加 `clearPersistent` 测辅助。④ 注意：in-flight reservation 仍可只在内存，committed 必须落库。 |
| **触及文件** | `src/db/schema.ts` · migration · 新 repo 或扩展 · `src/core/antidetect.ts` · `antidetect.test.ts` |
| **DoD** | 账号 A 评论成功 → 杀进程 → 账号 B 同 dedupKey → 仍拦截；token bind 同理 |
| **回滚** | env `XHS_MCP_AD_PERSIST=false` 退回纯内存（文档标明） |

### A6 ·（可选增强）禁止单次调用同 note 多账号写

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P1 |
| **依据** | 03 P1-6 · 整改 §9 |
| **做什么** | `executeWithMultipleAccounts`：若 `accountNames.length>1` 且 `logParams`/显式 `noteId` 存在于互动类 action，直接整批拒绝或只允许第一账号（推荐整批拒绝 + 明确错误）。 |
| **触及文件** | `src/core/multi-account.ts` · `src/tools/interaction.ts` |
| **DoD** | `accounts:all` + 同一 noteId like → 错误提示改用分次/错峰 |
| **回滚** | env 关闭 |

### A7 ·（可选）新号 / 同出口登录速率

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P1 |
| **依据** | 03 P1-7 |
| **做什么** | 同 proxy host 或「本机无 proxy」下，每日成功 `createAccountAfterLogin` 上限；超出拒绝新会话。 |
| **触及文件** | `login-session` / `tools/account.ts` · DB 计数 |
| **DoD** | 超限返回明确错误 |
| **回滚** | env 关闭，默认可先 off |

**Wave A 出口验收**：双号同机无独立 proxy 无法批量写；同 note 第二号赞被拦；xsec 默认 block；无固定评论句；重启后 dedup 仍在。

---

## Wave B — 行为真实性

**目标**：消灭「瞬移单动作 / 均匀时钟 / 无轨迹 / 零视频 / 评论无修订」。  
**预计触及**：`utils/index.ts` · `interact.ts` · `explore.ts` · `publish.ts` · `constants.ts` · 可能新文件 `pointer.ts` / `timing.ts`

### B1 · 重尾延迟原语

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 02 P0-3 · README Wave B.3 |
| **做什么** | 新增 `heavyTailDelay(mean, opts)`（log-normal 或截断 Pareto）；`jitteredSleep` 内部改用重尾；**`rateLimitedSleep` 保持「仅正向、≥ base」**。全仓行为等待逐步替换裸 `Math.random` 均匀采样（打字间隔、阅读停顿、滚动步间）。 |
| **触及文件** | `src/xhs/utils/index.ts` · 调用点 |
| **DoD** | 单测：采样 CV 与偏度高于均匀对照；rateLimited 最小值断言 |
| **回滚** | env `XHS_MCP_AD_HEAVY_TAIL=false` 退回均匀 |

### B2 · 指针轨迹点击原语

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 02 P0-2 · README Wave B.2 |
| **做什么** | 新增 `clickWithTrajectory(page, locator|element, opts)`：当前指针（或安全默认点）→ Bezier/Fitts 时长 `mouse.move({steps})` → `mousedown/up` 或 locator click。默认**禁止** `force: true`；force 仅 fallback + warn 日志。Explore 打开笔记、Interact 赞/藏/评、Publish 关键遮罩改走此原语；干掉常量 `mouse.click(400,50)` 或改为轨迹到「空白安全区」。 |
| **触及文件** | 新 util · `explore.ts` · `interact.ts` · `publish.ts` |
| **DoD** | 关键写路径点击前必有 move steps；explore 默认无 force |
| **回滚** | env 退回直接 click（仅应急） |

### B3 · Interact 会话化（禁止瞬移默认）

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 02 P0-1 · README Wave B.1 |
| **做什么** | 重构 `InteractService` 写路径模板：`openNoteSession` → 重尾 dwell → 短 `humanScroll` → 轨迹点击目标 → 短停留 → close。批处理同账号多 note 时**复用同一 page**（可选参数 `keepPage` / 内部池）。保留直链 goto（无 referrer 时不可避免），但补齐页内行为。 |
| **触及文件** | `src/xhs/clients/services/interact.ts` |
| **DoD** | 单次 like 的 page 存活时间与 wheel/move 事件可观测（日志或测试 hook）；不再「goto 后 <1s 关页」为常态 |
| **回滚** | 功能开关 `XHS_MCP_AD_SESSIONIZED_INTERACT` 默认 true |

### B4 · Explore：共享滚动 + 视频短接触 + 评论修订

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0/P1 |
| **依据** | 02 P0-5 · P1-1 · P1-4 · README Wave B.4 |
| **做什么** | ① 删除私有 `humanScroll`，改用 `utils.humanScroll` + `SCROLL_CONFIG`。② 去掉硬 filter 视频；按低概率打开视频 modal/短停留后关闭（无播放器自动化也可「打开即关」模拟划走）。③ `commentInModal` 的 `typeLikeHuman` 传入与发布类似的 revise 参数。④ 打开率兜底改为冷却/衰减，禁止线性 `+0.1` 爬到 0.9。⑤ 可见性：用 wheel 逼近替代裸 `scrollIntoViewIfNeeded`（或逼近失败再 fallback）。 |
| **触及文件** | `explore.ts` · 可能 `constants.ts` |
| **DoD** | 视频可进入 opened 统计；评论键入含 Backspace 修订（抽样）；无私有滚动函数 |
| **回滚** | 视频接触可用 `explore.allowVideo=false` 临时关 |

### B5 · 中文 IME 策略（评估 + 最小落地）

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0（策略）/ P1（实现） |
| **依据** | 02 P0-4 · README Wave B.5 |
| **做什么** | **Phase 1（本 Wave 必做）**：产品/代码明确风险——配置项 `typing.mode = 'raw' \| 'ime_best_effort'`；文档写清 raw 的 composition 缺口。**Phase 2**：调研 patchright/CDP `InsertText` vs `imeSetComposition`；能稳定产生 composition 事件则实现 `typeLikeHumanIme` 供中文评论/正文；不能则保持 raw + 限制长中文评论策略（短评/表情）。 |
| **触及文件** | `utils/index.ts` · 配置 · `docs/blue-team/02-*.md` 状态更新 |
| **DoD** | Phase1：配置与文档落地；Phase2：有 PoC 或 `wontfix` 书面原因 |
| **回滚** | 默认 `raw` |

### B6 · 跨路径限流与 DELAYS 对齐

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P1 |
| **依据** | 02 P1-7 · P2-2 |
| **做什么** | reply/likeComment 统一 `rateLimitedSleep(REQUEST_INTERVAL)`；搜索过滤器 DELAYS 改重尾抖动。 |
| **触及文件** | `interact.ts` · `search.ts` · `constants.ts` |
| **DoD** | 无固定 300/500/800 作为唯一节拍 |
| **回滚** | n/a |

**Wave B 出口验收**：Interact 有轨迹与 dwell；延迟分布非均匀；Explore 有视频接触且滚动与搜索一致；IME 策略成文。

---

## Wave C — 指纹与环境

**目标**：降低 command-line / 登录建档 / 出口旁路 / 登出语义异常。  
**说明**：真正的「一机一指纹」若无法上容器/云手机，本 Wave 只做**可配置的环境自洽**，并在文档写清残余风险。

### C1 · 收紧 BROWSER_ARGS

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 01 P0-2 · README Wave C.1 |
| **做什么** | 默认移除 `--no-sandbox` / `--disable-setuid-sandbox` / `--deny-permission-prompts`；`--disable-blink-features=AutomationControlled` 若 patchright 已注入则勿重复。沙箱类仅当 `XHS_MCP_BROWSER_NO_SANDBOX=true` 追加。 |
| **触及文件** | `constants.ts` · `config.ts` · CLAUDE.md / README 环境变量表 |
| **DoD** | 默认启动 command line 无 no-sandbox；CI 文档说明如何开 |
| **回滚** | env 打开 no-sandbox |

### C2 · 登录强制 headful

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0 |
| **依据** | 01 P0-3 · README Wave C.2 |
| **做什么** | `LoginSessionManager.createSession` **忽略**全局 headless，强制 `headless: false` 且 `viewport: null`。全局 `XHS_MCP_HEADLESS` 仅影响非登录只读（写仍被 gate 拦）。 |
| **触及文件** | `login-session.ts` · `context.ts`（可加 `purpose: 'login'\|'ops'`） |
| **DoD** | `HEADLESS=true` 时 add_account 仍弹出/创建有头窗口；无 1920×1080 固定 viewport |
| **回滚** | 显式 `XHS_MCP_ALLOW_HEADLESS_LOGIN=true`（默认 false，仅测试） |

### C3 · 账号级 timezone / locale / geolocation 与代理对齐

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0/P1 |
| **依据** | 01 P0-1 · P1-1 · README Wave C.3 |
| **做什么** | accounts 表（或 JSON config）增加可选 `timezone_id` / `locale` / `geolocation`；`launchPersistentContext` 传入。提供「按代理国家推荐」的辅助（可先手工配置）。**不**默认伪造 UA（遵守 patchright 建议）；若未来注入 UA 必须与 Chrome 版本一致且持久化。文档写清：同机硬件指纹仍共享，完整隔离需一容器一账号。 |
| **触及文件** | schema · accounts repo · `context.ts` · `tools/account.ts` |
| **DoD** | 配置后页面 `Intl`/`Date` 时区与配置一致；与代理属地文档校验清单 |
| **回滚** | 字段空则不传（现状） |

### C4 · 发布配图走 APIRequestContext

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P1 |
| **依据** | 01 P1-4 · README Wave C.4 |
| **做什么** | `downloadImageFromUrl` / `resolveImagePaths` 接受 `APIRequestContext`（或 Account 上下文）；`PublishService` 从 `ctx.request` 下载。禁止业务路径 Node 裸 `fetch` 拉小红书相关资源。 |
| **触及文件** | `utils/index.ts` · `publish.ts` · 调用方 |
| **DoD** | 带 proxy 账号下载配图走代理（可用 mock server 测 Host） |
| **回滚** | n/a |

### C5 · 登出 = 归档 profile

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P1 |
| **依据** | 01 P1-5 · README Wave C.5 |
| **做什么** | `deleteCookies` 语义升级或新 API：`clearSession({ archiveProfile: true })` → 归档目录 + 清 DB state + 关浏览器；仅 clearCookies 标 deprecated。 |
| **触及文件** | `context.ts` · `tools` 删除 cookie 工具 · `profile.ts` |
| **DoD** | 登出后旧 profile 目录被 rename 归档，不残留可复用设备盐于同路径 |
| **回滚** | 保留旧 clearCookies 行为开关 |

### C6 · evaluate world 策略封装

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P2 |
| **依据** | 01 P1-2 · P1-3 |
| **做什么** | `evalMainState(page, fn)` / `evalDom(page, fn)` 封装；`__INITIAL_STATE__` 统一 main；纯 DOM 默认 isolated。 |
| **触及文件** | 新 util · 各 services 替换 |
| **DoD** | 无散落「有的 false 有的默认」无注释调用 |
| **回滚** | n/a |

### C7 · 文档与安装对齐

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P2 |
| **依据** | 01 P2-1 · P2-2 |
| **做什么** | 删除/更正 `stealth.js` 描述；postinstall/文档明确系统 Chrome；环境变量表同步本 plan 所有开关。 |
| **触及文件** | `CLAUDE.md` · `README*` · `package.json` scripts |
| **DoD** | 文档无虚假 stealth；新开关有表项 |
| **回滚** | n/a |

**Wave C 出口验收**：默认 args 干净；登录必 headful；代理账号可绑时区；配图下载同源 egress；登出归档。

---

## 5. 依赖与建议实施顺序

```text
A1 proxy ──┬── A2 dedupKey（可并行）
           ├── A3 xsec（可并行）
           ├── A4 comment fallback（可并行）
           └── A5 persist（依赖 A2/A3 键语义稳定后做更顺）

A 完成后 → B1 timing ──→ B2 pointer ──→ B3 interact session
                      └──────────────→ B4 explore
B5 IME Phase1 可与 B1 并行；Phase2 不阻塞合入

C1/C2 可与 B 并行（冲突少）
C3 依赖 A1 proxy 模型
C4 依赖 context.request 已有
C5 独立
```

**推荐迭代切片（便于 PR）：**

| PR | 内容 |
|----|------|
| PR-A1 | A1 + 文档开关 |
| PR-A2 | A2 + A6 |
| PR-A3 | A3 |
| PR-A4 | A4 |
| PR-A5 | A5 持久化 |
| PR-B1 | B1 |
| PR-B2 | B2 + B3 |
| PR-B3 | B4 + B6 |
| PR-B4 | B5 Phase1（+ Phase2 若成） |
| PR-C1 | C1 + C2 + C7 |
| PR-C2 | C3 + C4 |
| PR-C3 | C5 + C6 |

---

## 6. 总验收清单（全 Wave 完成后）

- [ ] 多账号写必须互异 proxy；同 proxy 被拒
- [ ] 同 note 第二账号 like/fav 被拒
- [ ] xsec 默认 block；explore 提取即绑定
- [ ] 无「很棒的分享！」；AI 失败跳过
- [ ] 重启后 dedup/xsec 仍生效
- [ ] Interact 有轨迹 + dwell；非秒开关页
- [ ] 延迟重尾；rateLimited ≥ base
- [ ] Explore 可接触视频；共享 humanScroll
- [ ] 登录无视全局 headless；viewport null
- [ ] 默认无 no-sandbox；配图走账号 request
- [ ] `01/02/03` 对应 P0 项标 mitigated

---

## 7. 明确不在本 plan 范围

| 项 | 原因 |
|----|------|
| 容器/云手机级硬件指纹隔离 | 基础设施项目，代码层只能文档约束 + C3 自洽 |
| 语义 embedding 近邻去重 / pHash | 可作 Wave D；A4 精确 SHA 为前置 |
| 重写整个 MCP 协议或换驱动 | 保持 patchright |
| 把 liveness 当拟人指标优化 | 运维门禁，另册 |

---

## 8. 实施时操作说明

1. 开做某项：把该行 **状态** 改为 `doing`，开分支 `feat/blue-a1-proxy` 等。  
2. 合入后：改 `done`，在对应蓝军文档向量下追加 `mitigated: <PR/commit>`。  
3. 若否决：`wontfix` + 一行原因（须产品确认，尤其 IME / 同机指纹）。  
4. **不要**在未完成 A1–A5 前扩大多账号 `accounts:all` 写流量。
