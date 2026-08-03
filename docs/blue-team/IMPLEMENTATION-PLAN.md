# 实施计划 · 蓝军整改（依据 `docs/blue-team/`）

> **用途**：后续按本 plan 分波次实施与验收。  
> **依据**：[README](./README.md) · [01](./01-fingerprint-environment.md) · [02](./02-behavior-authenticity.md) · [03](./03-multi-account-association.md)  
> **Review 修订**：三路均为 `request-changes`（[指纹](1600ce01-1923-47b5-a075-6f4f0114d87c) · [行为](0311295f-d10a-4c72-ad56-df51121c63fa) · [关联](fded0b7d-f3b2-413b-b62c-310d03882ae0)），本版已吸收。  
> **状态约定**：`todo` → `doing` → `done` / `wontfix`。

---

## 0. 全局约束

| 约束 | 说明 |
|------|------|
| MCP 契约 | 新增约束用 env；迁移期可 `warn`；默认收紧须 CHANGELOG |
| 门禁分轨 | liveness / headlessWriteGate 保持；不作「拟人完成」指标 |
| **A1 ↔ C3+C8 捆绑** | A1 强制 proxy 后，C3（timezone/locale/geo）与 C8（WebRTC）不得长期滞后 |
| **键空间先冻结再持久化** | A5 必须在 A2+A3+A4 之后 |
| 禁止错误自洽 | 勿在无属地校验时瞎填 geolocation/locale |
| 测试 | 守卫/多账号补测；行为原语测分布与轨迹 hook |
| 文档 | 完成后在 01/02/03 标 `mitigated` + PR |

---

## Wave A — 关联与出口

### A1 · 代理硬约束 + 认证 proxy

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | ① proxy 支持 `{ server, username?, password? }`（DB JSON 或规范化 URL）。② **`accounts.length>1` 或 `all`**：每账号非空且规范化 `server`（host:port）互异，否则 skip/`proxy_required` 或 `proxy_shared`。③ **单账号写**：默认允许无 proxy（威胁模型：单号同机风险低于多号共现）；文档标明。④ env：`XHS_MCP_AD_PROXY_REQUIRED` — 多账号批次默认强制；提供迁移期 `warn`（只日志不拦）→ 再切 `block`。⑤ **不做 /24 匹配**（无出口 IP 解析）；若未来要做则单列 P1+DoD。⑥ 与 C3 联调列入出口验收。 |
| **触及** | `config.ts` · `multi-account.ts` · `proxy.ts` · `context.ts` · `tools/account.ts` · [A1-PROXY-RUNBOOK.md](./A1-PROXY-RUNBOOK.md) |
| **DoD** | 双账号无 proxy / 同 server → 被拦；认证 proxy 传入 launch；单测覆盖；存量账号审计脚本或文档 runbook |
| **回滚** | `warn` 模式或 `false` |

### A2 · 互动目标 dedup + **键空间统一**（硬要求）

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | ① 工具：`like:note:${noteId}` · `fav:note:${noteId}` · `like_c:${noteId}:${commentId}`。② **同步改 explore.ts**：弃用或别名映射 `explore:like:` → 同一前缀，使工具赞与 explore 赞互斥。③ unlike/unfavorite 与 like **共用**目标键（防踩踏）。④ 跨路径单测必过。 |
| **触及** | `tools/interaction.ts` · `explore.ts` · 测试 |
| **DoD** | 账号 A explore like note X 后，账号 B 工具 like X → `cross_account_dedup`（持久化前同进程；持久化后跨重启） |
| **回滚** | `XHS_MCP_AD_DEDUP=false` |

### A3 · xsec 默认 block + explore bind

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | 默认 `mode='block'`（**breaking**：仓库无 CHANGELOG.md，已在 `config.ts` 内联注释说明并在本行记录）；`getFeeds` 后立即 `bindXsecSource`（`bindFeedXsecTokens` 辅助函数，`src/xhs/clients/services/explore.ts`）；确认 search/list_feeds（`tools/content.ts`）绑定逻辑未回退。 |
| **DoD** | B 用 A 的 token 写 → 拒绝（block 模式默认生效）；explore 提取 feed 即 committed（早于点赞/评论） |
| **回滚** | `XHS_MCP_AD_XSEC_MODE=warn` |

### A4 · 去掉固定 fallback + 正文键对齐

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | ① `generateComment` 失败 → 无评论 / 调用方跳过；**禁止**「很棒的分享！」。② `selectLikeTarget` 失败 → `target: 'none'`。③ explore 评论 `dedupKey` 至少 `comment_text:${sha256OfText(content)}`（可双键含 noteId），与 `interaction.ts` **同一前缀**。 |
| **触及** | `core/explore-ai.ts` · `xhs/clients/services/explore.ts` · `core/explore-ai.test.ts` · `core/antidetect.test.ts` |
| **DoD** | Gemini mock 失败不增 `notesCommented`；同文案跨帖第二账号被拦（explore↔工具） |
| **回滚** | 无——禁止恢复固定句 |

### A5 · Guard 持久化（A2+A3+A4 之后）

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | 表：`ad_dedup_keys` · `ad_xsec_tokens`（token **hash**）；committed 落库；in-flight 可内存；`XHS_MCP_AD_PERSIST`；TTL/GC 约定；`clearPersistent` 测辅。 |
| **触及** | `antidetect.ts` · `db/repos/antidetect-persist.ts` · `schema.ts` · `config.ts` · `db/index.ts` |
| **DoD** | 杀进程后：工具赞↔explore 赞、`comment_text` 跨帖、xsec bind 仍拦截 |
| **回滚** | `XHS_MCP_AD_PERSIST=false` |
| **顺序** | **禁止**早于 A2+A4 合入 |

### A6 · 拒绝单次同 note 多账号写

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P1 |
| **依据** | 03 整改「单次调用同 note」——非 P1-6 波次 |
| **做什么** | `accountNames.length>1` 且互动类带同一 `noteId` → 整批拒绝。 |
| **DoD** | `accounts:all` + 同 note like → 明确错误 |

### A7 · 新号登录速率（可选）

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P1 |
| **做什么** | 同 proxy host / 本机无 proxy 下每日成功登录上限；默认 env off。 |

**Wave A 出口**：多账号互异 proxy；键空间统一且跨路径互斥；xsec block；无固定评论/默认赞帖；A5 后重启仍生效；**不宣称 /24**。

---

## Wave B — 行为真实性

### B1 · 重尾行为延迟（勿吞掉 jitteredSleep）

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | 新增 `heavyTailDelay`；**仅**用于行为等待（打字间隔、阅读停顿、滚动步间、Interact dwell）。`jitteredSleep` 保留给功能等待（发布轮询、上传）。`rateLimitedSleep` 仍 `≥ base`。DoD 附**调用点迁移清单**。 |
| **触及** | `utils/index.ts` · `interact.ts` · `explore.ts` · [B1-CALL-SITES.md](./B1-CALL-SITES.md) |
| **回滚** | `XHS_MCP_AD_HEAVY_TAIL=false` |

### B2 · 指针轨迹点击

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | `clickWithTrajectory`：Bezier/Fitts，**DoD：`steps≥N`（建议 N≥5）或轨迹 hook 可观测**；默认禁 `force`；force 仅 fallback+warn。替换 explore/interact/publish 关键遮罩常量坐标。 |
| **回滚** | `XHS_MCP_AD_TRAJECTORY=false` → 直点 |

### B3 · Interact 会话化

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | 模板：goto → 重尾 dwell → ≥1 阅读 scroll/wheel → 轨迹 click → 动作后停留 → close。可选 `keepPage`。**保留直链**；有机 feed 点入 → Wave D。 |
| **DoD（替换旧「&lt;1s」）** | 单次 like 默认可观测：重尾 dwell、≥1 次阅读滚动、轨迹 `steps≥N`、动作后停留 ≥ Y；**禁止**仅用「goto 后 &lt;1s 关页」验收（现状已因 REQUEST_INTERVAL 满足该假条件）。 |
| **依赖** | 建议 B1+B2 先合；若 PR 合并 B2+B3，须在 PR 内自带最小重尾 dwell |
| **回滚** | `XHS_MCP_AD_INTERACT_SESSION=false` |
| **触及** | [B3-CALL-SITES.md](./B3-CALL-SITES.md) |

### B4 · Explore 滚动 preset + 视频 + revise

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0/P1 |
| **做什么** | ① 删私有滚动；用 **`SCROLL_CONFIG_EXPLORE`**（步间短于搜索，避免拖垮 `duration`）。② 视频按 **相对 feed 视频占比的接触率**，不能只「打开即关」凑 opened。③ 评论 revise 参数。④ 打开率改冷却/衰减。⑤ wheel 逼近替代裸 `scrollIntoViewIfNeeded`。 |
| **回滚** | `XHS_MCP_AD_EXPLORE_ALLOW_VIDEO=false` |
| **触及** | [B4-CALL-SITES.md](./B4-CALL-SITES.md) |

### B5 · IME 策略

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 策略 / P1 实现 |
| **做什么** | Phase1：`typing.mode` + 文档风险。Phase2：composition PoC 或 `wontfix`。 |
| **结论** | Phase2 = **wontfix**（可信 CDP 无法模拟真实中文 IME composition）；`ime` 模式降级 `direct` + warn。见 [B5-IME.md](./B5-IME.md) |
| **回滚** | 默认 `direct`；`XHS_MCP_AD_TYPING_MODE=ime` 仅 warn 不改路径 |

### B6 · 限流与固定节拍清扫

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P1 |
| **做什么** | reply/likeComment → `rateLimitedSleep`；搜索 DELAYS 重尾；**`findCommentElement` 固定 800ms**；**explore modal 写间隔**加 rate limit；Interact 评论/回复 revise（呼应 P1-4）。 |
| **DoD** | 生产路径无「唯一节拍」300/500/800 |
| **触及** | `interact.ts` · `search.ts` · `explore.ts` · [B6-CALL-SITES.md](./B6-CALL-SITES.md) |

### B7 · 导航重试与 alreadyDone 短会话

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P1 |
| **依据** | 02 P1-11 / P1-12（review 增补） |
| **做什么** | ① `navigateWithRetry`：失败重载改为重尾间隔 + 上限；禁止 3–5s 均匀连刷同一 URL 成节拍器。② `alreadyDone`（已赞/已藏）：可选短 dwell 后关，或跳过 goto（若调用方能先知状态）；避免「直链探活 → 秒读 state → 关」纯探测会话图。③ 日志区分 `skipped_already_done` vs 真实互动会话。 |
| **触及** | `utils/index.ts` `navigateWithRetry` · `interact.ts` |
| **DoD** | 重试间隔分布可检非均匀；alreadyDone 路径有明确策略（跳过或短会话）且单测/日志可区分 |
| **回滚** | env 关新策略 |

**Wave B 出口**：Interact 有 dwell+滚动+多步轨迹；行为延迟重尾且功能等待未误伤；Explore 视频接触率可检；IME 策略成文；重试/alreadyDone 不再形成均匀探测指纹；feed 点入未承诺为本 Wave。

---

## Wave C — 指纹与环境

### C1 · 收紧 BROWSER_ARGS

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | 默认移除 no-sandbox / deny-permission-prompts；删重复 AutomationControlled。**容器/CI DoD**：文档写明必须 `XHS_MCP_BROWSER_NO_SANDBOX=true` 否则启动失败属预期。 |
| **回滚** | env 开 no-sandbox |

### C2 · 登录强制 headful

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P0 |
| **做什么** | login 忽略全局 headless；`viewport: null`。无 DISPLAY：Xvfb 或 `XHS_MCP_ALLOW_HEADLESS_LOGIN=true`（默认 false）。 |
| **DoD** | `HEADLESS=true` 时 add_account 仍 headful（有图形环境）；无图形环境有文档路径 |

### C3 · timezone / locale / geo（与 A1 捆绑）

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0/P1 |
| **做什么** | DB 字段；launch 传入；`grantPermissions(['geolocation'])`；与 C1 去掉 deny 联调；校验 `Intl` + `navigator.languages` / Accept-Language；**禁止无属地时瞎填 geo**。不默认伪造 UA。 |
| **DoD** | 配置后时区与 languages 一致；A1 多账号场景联调通过 |

### C4 · 配图下载对齐 downloadFile

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P1 |
| **做什么** | `resolveImagePaths` 走账号 `APIRequestContext`；**复用/抽取** `tools/download.ts` 的 Referer + Sec-Fetch；禁止业务裸 `fetch` 拉资源。Gemini `fetch` 注明非浏览 egress（范围外但关联面知悉）。 |
| **DoD** | 配图请求头与账号下载一致且走 proxy |
| **触及** | [C4-IMAGE-DOWNLOAD.md](./C4-IMAGE-DOWNLOAD.md) · `core/account-download.ts` · `utils/index.ts` · `publish.ts` |

### C5 · 登出归档 profile

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P1 |
| **做什么** | 复用 `profile.ts` 归档模式；`clearCookies` 标 deprecated。术语：归档的是 profile 内持久化标识，非硬件指纹。 |
| **触及** | [C5-LOGOUT-ARCHIVE.md](./C5-LOGOUT-ARCHIVE.md) · `profile.ts` · `context.ts` · `tools/interaction.ts` |

### C6 · evaluate / waitForFunction 策略

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P2 |
| **做什么** | `evalMainState` / `evalDom`；**另**：`waitForFunction` 无 world 开关 → 封装主世界等待或轮询+isolated evaluate；注释标准。 |

### C7 · 文档与安装对齐

| 字段 | 内容 |
|------|------|
| **状态** | done |
| **优先级** | P2 |
| **做什么** | 删 stealth.js；修正 **CLAUDE.md**（headless 默认、登录是否 headless、去掉不存在的 `stealth.js`）；README/环境变量表同步本 plan 全部开关（含 B7/C8）。 |
| **DoD** | CLAUDE.md 与 `config.ts` 默认值一致；无虚假 stealth 描述 |

### C8 · WebRTC / ICE 本地 IP 泄漏缓解

| 字段 | 内容 |
|------|------|
| **状态** | todo |
| **优先级** | P0/P1 |
| **依据** | 01 P0-4（指纹 review） |
| **做什么** | ① A1 启用 proxy 时，评估并落地 WebRTC 抑制（如 Chromium 策略 / `webrtc.ip_handling` / 权限或 init 策略——须不引入可观测异常指纹）。② 自检脚本或手工清单：代理下 `RTCPeerConnection` ICE 候选是否仍暴露宿主/机房 IP。③ 若技术不可行：`wontfix` + 威胁模型（仅信任不泄漏的代理类型），写入 01。④ 与 A1 联调：有 proxy 无 WebRTC 缓解不得标 A1 完全 mitigated。 |
| **触及** | `context.ts` / launch args 或 context 选项 · 文档 · 可选 scripts |
| **DoD** | 代理会话下 ICE 无宿主公网/局域网泄漏，或书面 `wontfix`；自检步骤进 01 §5 |
| **回滚** | env 关闭抑制（默认开当 A1 proxy 启用时） |
| **依赖** | 与 A1 捆绑验收；可与 C3 同 PR |

**Wave C 出口**：args 干净+容器说明；登录 headful；A1+C3 自洽；配图头一致；登出归档；**WebRTC 已缓解或书面接受**；CLAUDE.md 与 live config 一致。

---

## Wave D — 延后项（本轮不实施，仅挂账）

| ID | 项 | 说明 |
|----|-----|------|
| D1 | Interact `entry: 'feed'\|'direct'` 有机点入 | 从 explore/search 列表点入替代直链 goto |
| D2 | 评论/媒体近邻去重（embedding / pHash） | A4 精确 SHA 之后 |
| D3 | 同 /24 代理共现检测 | 需出口 IP 解析；当前不做 |
| D4 | 容器/云手机级硬件指纹隔离 | 基建 |

---

## 5. 依赖与 PR 切片

```text
A1 ──┬── A2（含 explore 键对齐）──┐
     ├── A3                         ├──► A5（键冻结后）
     └── A4 ───────────────────────┘
A1 完成 → 尽快 C3 + C8（捆绑），可与 B 并行但不得滞后上量

B1 → B2 → B3
B4 ∥ B2 后半；B5 Phase1 ∥ B1；B6 ∥ B4；B7 ∥ B3

C1/C2 ∥ B
C3 + C8 after/with A1
C4 · C5 · C6 · C7 相对独立
```

| PR | 内容 |
|----|------|
| PR-A1 | A1 + 迁移 runbook |
| PR-A2 | A2（工具+explore 键）+ A6 |
| PR-A3 | A3 |
| PR-A4 | A4 |
| PR-A5 | A5（不得早于 A2+A4） |
| PR-B1 | B1 |
| PR-B2 | B2 + B3（含最小重尾 dwell） |
| PR-B3 | B4 + B6 |
| PR-B4 | B5 + B7 |
| PR-C1 | C1 + C2 + C7 |
| PR-C2 | C3 + C8 + C4（A1 后） |
| PR-C3 | C5 + C6 |

---

## 6. 总验收清单

- [ ] 多账号写互异 proxy；同 server 被拒；迁移 warn→block 有记录
- [ ] 工具 like ↔ explore like 互斥；同文案跨帖互斥
- [ ] xsec 默认 block；explore 提取即 bind
- [ ] 无固定评论句；AI 失败不默认赞帖
- [ ] 重启后 dedup/xsec 仍生效
- [ ] Interact：dwell + 阅读滚动 + steps≥N 轨迹（非「&lt;1s」假 DoD）
- [ ] 行为重尾；功能 `jitteredSleep` 未误伤；rateLimited ≥ base
- [ ] Explore 视频接触率可检；explore 滚动 preset
- [ ] `navigateWithRetry` / `alreadyDone` 无均匀探测指纹
- [ ] 登录强制 headful（有图形时）；容器 no-sandbox 有文档
- [x] A1+C3 时区/languages 自洽；配图 Referer/Sec-Fetch 对齐（配图 C4 done；C3 仍待）
- [ ] 代理下 WebRTC ICE 无宿主泄漏（或 `wontfix` 书面）
- [x] CLAUDE.md 与 config 默认一致、无 stealth.js 虚述
- [ ] 01/02/03 对应 P0 标 mitigated

---

## 7. 明确不在本轮范围（见 Wave D）

| 项 | 原因 |
|----|------|
| 容器/云手机硬件指纹 | Wave D4 / 基建 |
| 同 /24 代理检测 | Wave D3 |
| feed 有机点入 | Wave D1 |
| embedding / pHash | Wave D2 |
| 换驱动 / 重写 MCP | 保持 patchright |

---

## 8. 实施操作

1. 项状态改 `doing`，分支如 `feat/blue-a2-dedup-keys`。  
2. 合入后 `done` + 蓝军文档 `mitigated`。  
3. `wontfix` 须产品确认（IME / 同机指纹 / WebRTC）。  
4. **未完成 A1–A5（含键统一）前禁止扩大 `accounts:all` 写流量。**  
5. **未完成 C3+C8 前谨慎扩大异地代理多账号写。**
