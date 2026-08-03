# 蓝军分析（2026-08 独立审计）

> **性质**：从零静态审计，不依赖 `docs/blue/` 既有报告。  
> **目标**：识别小红书侧可能用来判定「AI / 自动化农场」的信号，并给出整改优先级。  
> **方法**：三个独立角度并行分析后交叉合成；经三路独立 review 修订（见文末）。

| 文档 | 角度 | 分析子代理 | 文档 review |
|------|------|------------|-------------|
| [01-fingerprint-environment.md](./01-fingerprint-environment.md) | 浏览器 / 设备指纹 / CDP / 环境一致性 | [指纹面](d572560e-4fe8-4769-861c-0bb0ef82e69d) | [指纹 review](1600ce01-1923-47b5-a075-6f4f0114d87c) |
| [02-behavior-authenticity.md](./02-behavior-authenticity.md) | 键鼠轨迹 / 延迟分布 / 导航会话 / Explore | [行为面](54d8298e-07df-4ae8-bc86-c82c5a51874d) | [行为 review](0311295f-d10a-4c72-ad56-df51121c63fa) |
| [03-multi-account-association.md](./03-multi-account-association.md) | 多账号关联图 / 出口 / 内容指纹 / AI 聚类 | [关联面](9c6198b1-2c72-44d0-8c16-632eb28060ef) | [关联 review](fded0b7d-f3b2-413b-b62c-310d03882ae0) |

---

## 一句话总判

单会话底座（patchright + 真 Chrome + CDP Input 可信事件 + 独立 profile）能擦掉大量**经典自动化标志位**，但仍有 main-world `evaluate(false)` / 默认 `waitForFunction(main)`、以及行为层「直链 → 页内无阅读 → 单步点击 → 关页」等缺口。平台真正用来打穿农场的三类信号——**同机硬件指纹共现、任务式互动会话、多账号 IP/内容/同帖共现（含 dedup 键空间分裂）**——在默认配置下几乎裸奔。现有 `CooccurrenceGuard` / liveness / headless 写门禁是**运维自保**，不是设备/行为层的反检测。

---

## 跨角度 P0 红线（必须先做）

| # | 红线 | 所属面 | 代码锚点（示意） |
|---|------|--------|------------------|
| 1 | 同机多账号共享 Canvas/WebGL/字体等硬件指纹；proxy 可选且不与时区/locale 对齐；代理下 WebRTC 可泄真实 IP | 指纹 + 关联 | `context.ts` `launchPersistentContext` |
| 2 | Interact「直链 goto →（限流后）一点即关」：缺阅读滚动 / 多步 Fitts 轨迹 / 有机入站；延迟为均匀族；中文无 IME composition | 行为 | `interact.ts` / `utils/index.ts` |
| 3 | **MCP 互动工具** like/fav 无目标 `dedupKey`（explore 已有 `explore:like:*`，键空间不一致）；xsec 默认 warn；AI 失败刷「很棒的分享！」；Guard 仅内存 | 关联 | `interaction.ts` / `explore.ts` / `explore-ai.ts` |
| 4 | 当 `XHS_MCP_HEADLESS=true` 时登录可走 headless + 固定 1920×1080 viewport（建档窗口）。出厂默认 headless=`false` | 指纹 | `login-session.ts` / `config.ts` |
| 5 | Explore 硬跳过全部视频 | 行为 | `explore.ts` filter `type === 'video'` |

---

## 整改路线图（建议波次）

### Wave A — 关联与出口（否则上量必团灭）

1. 多账号写强制互异认证 proxy；单账号写策略与迁移期 `warn` 见 plan A1（与 README 口径已对齐）。
2. **统一**工具路径与 explore 的目标/正文 dedup 键空间（`like:note:` / `comment_text:` 等）。
3. xsec 生产默认 `block`；explore feed 提取后 `bindXsecSource`。
4. 去掉固定评论 fallback；`selectLikeTarget` 失败 → `none`；评论键与工具路径对齐。
5. Guard 持久化（**必须在 A2+A3+A4 键语义冻结之后**）。

**约束**：A1 合入后 C3（时区/locale/geo）不得长期滞后，否则「异地 IP + 宿主机时区」比无代理更像农场。

### Wave B — 行为真实性

1. Interact 会话化：重尾 dwell + 阅读滚动 + Fitts 多步轨迹 + 动作后停留（**「从 feed 点入」列为 Wave D**）。
2. 统一轨迹点击原语；`force: true` 仅 fallback。
3. 新增 `heavyTailDelay` **仅替换行为等待**；勿默改全局 `jitteredSleep`；`rateLimitedSleep` 保 `≥ base`。
4. Explore：独立滚动 preset + 视频短接触 + 评论 revise；Interact 评论/回复同样开 revise。
5. 中文 IME：Phase1 策略成文；Phase2 实现或 `wontfix`。
6. **B7**：`navigateWithRetry` 重尾重试；`alreadyDone` 短探测会话治理。

### Wave C — 指纹与环境

1. 收紧 `BROWSER_ARGS`（真风险：no-sandbox / deny-permission-prompts / disable-infobars；AutomationControlled 与 patchright 重复可删）。
2. 登录强制 headful + `viewport: null`；无 DISPLAY 环境文档化回滚/Xvfb。
3. 账号级 timezone/locale/geolocation + `grantPermissions` 与代理属地对齐（与 A1 捆绑验收）。
4. 发布配图走 `APIRequestContext`，**对齐** `downloadFile` 的 Referer/Sec-Fetch。
5. 登出语义改为归档 profile。
6. **C8**：代理下 WebRTC/ICE 泄漏缓解（与 A1 捆绑）；**C7**：修正 CLAUDE.md 与 live config。

---

## 运维门禁 vs 反检测（勿混淆）

| 机制 | 作用 | 是否改变平台可见行为指纹 |
|------|------|--------------------------|
| `CooccurrenceGuard` 串行/配额/熔断 | 降同步尖峰、控频率 | 部分（时序仍有 30–120s 波次） |
| `liveness` 息屏停写 | 无人值守自保 | 否 |
| `headlessWriteGate` | 强制 headful 写 | 间接（避免 headless 组合异常） |
| 独立 `profileId` | Cookie/存储隔离 | **不**隔离硬件指纹（代码注释「设备指纹盐」仅指 profile 内持久化标识） |

---

## 实施计划

按波次落地的可执行 backlog（含 DoD、触及文件、回滚开关、PR 切片）见：

→ **[IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)**  
→ A1 迁移：[A1-PROXY-RUNBOOK.md](./A1-PROXY-RUNBOOK.md)

顺序：**Wave A（关联/出口）→ Wave B（行为）→ Wave C（指纹/环境）**；A1 与 C3 捆绑约束见上。未完成 A1–A5（含键空间统一）前不要扩大 `accounts:all` 写流量。

---

## 文档维护

- 本目录为 **2026-08 独立审计** 基线；后续整改请在对应文档追加「状态：open / mitigated」与 PR 链接。
- 不覆盖、不引用 `docs/blue/01–08` 旧报告结论；若历史结论与本文冲突，以本文源码证据为准。
- **2026-08-03**：三路 review 均为 `request-changes`，已吸收进本文档与 plan（本修订）。
