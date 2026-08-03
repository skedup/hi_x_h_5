# 蓝军分析（2026-08 独立审计）

> **性质**：从零静态审计，不依赖 `docs/blue/` 既有报告。  
> **目标**：识别小红书侧可能用来判定「AI / 自动化农场」的信号，并给出整改优先级。  
> **方法**：三个独立角度并行分析后交叉合成。

| 文档 | 角度 | 分析子代理 |
|------|------|------------|
| [01-fingerprint-environment.md](./01-fingerprint-environment.md) | 浏览器 / 设备指纹 / CDP / 环境一致性 | [指纹面](d572560e-4fe8-4769-861c-0bb0ef82e69d) |
| [02-behavior-authenticity.md](./02-behavior-authenticity.md) | 键鼠轨迹 / 延迟分布 / 导航会话 / Explore | [行为面](54d8298e-07df-4ae8-bc86-c82c5a51874d) |
| [03-multi-account-association.md](./03-multi-account-association.md) | 多账号关联图 / 出口 / 内容指纹 / AI 聚类 | [关联面](9c6198b1-2c72-44d0-8c16-632eb28060ef) |

---

## 一句话总判

单会话「自动化痕迹擦除」底座正确（patchright + 真 Chrome + 可信 CDP 事件 + 独立 profile），但平台真正用来打穿农场的三类信号——**同机硬件指纹共现、任务式瞬移会话、多账号 IP/内容/同帖共现**——在默认配置下几乎裸奔。现有 `CooccurrenceGuard` / liveness / headless 写门禁是**运维自保**，不是设备/行为层的反检测。

---

## 跨角度 P0 红线（必须先做）

| # | 红线 | 所属面 | 代码锚点（示意） |
|---|------|--------|------------------|
| 1 | 同机多账号共享 Canvas/WebGL/字体/UA/时区；代理可选且不与时区对齐 | 指纹 + 关联 | `context.ts` `launchPersistentContext` |
| 2 | Interact「新页 → 直链 → 一击 → 关页」；无指针轨迹；延迟均匀分布；中文无 IME | 行为 | `interact.ts` / `utils/index.ts` `typeLikeHuman` |
| 3 | `accounts:all` 点赞无目标去重；xsec 默认 warn；AI 失败刷「很棒的分享！」；Guard 仅内存 | 关联 | `interaction.ts` / `explore-ai.ts` / `antidetect.ts` |
| 4 | 登录仍可 headless + 固定 1920×1080 viewport（建档窗口） | 指纹 | `login-session.ts` / `context.ts` |
| 5 | Explore 硬跳过全部视频 | 行为 | `explore.ts` filter `type === 'video'` |

---

## 整改路线图（建议波次）

### Wave A — 关联与出口（否则上量必团灭）

1. 写操作强制每账号独立住宅/移动代理；支持认证 proxy；同 `server` 多账号拒绝。
2. like/favorite/like_comment 增加跨账号目标 `dedupKey`。
3. xsec 生产默认 `block`；explore feed 提取后 `bindXsecSource`。
4. 去掉固定评论 fallback；评论去重按正文 SHA（及近邻）。
5. Guard 的 dedup/token 绑定落库，跨重启生效。

### Wave B — 行为真实性

1. Interact 会话化：dwell + 阅读滚动 + Fitts 指针轨迹 + 停留，禁止瞬移单动作默认路径。
2. 统一点击原语（mousemove 轨迹）；`force: true` 仅 fallback。
3. 延迟改为 log-normal / 重尾；保留 `rateLimitedSleep`「≥ base」不变量。
4. Explore 复用共享 `humanScroll`；纳入视频短接触；评论启用 revise。
5. 中文 IME：评估 CDP composition 或产品层接受风险边界（当前代码已诚实承认缺口）。

### Wave C — 指纹与环境

1. 收紧 `BROWSER_ARGS`（去掉默认 `--no-sandbox` / `--deny-permission-prompts`）。
2. 登录强制 headful，禁止建档期固定 viewport。
3. 账号级 `timezoneId` / `locale` / `geolocation` 与代理属地绑定并持久化。
4. 发布配图下载改走账号 `APIRequestContext`，消灭 Node `fetch` 旁路。
5. 登出语义改为归档 profile，而非只 `clearCookies`。

---

## 运维门禁 vs 反检测（勿混淆）

| 机制 | 作用 | 是否改变平台可见行为指纹 |
|------|------|--------------------------|
| `CooccurrenceGuard` 串行/配额/熔断 | 降同步尖峰、控频率 | 部分（时序仍有 30–120s 波次） |
| `liveness` 息屏停写 | 无人值守自保 | 否 |
| `headlessWriteGate` | 强制 headful 写 | 间接（避免 headless 组合异常） |
| 独立 `profileId` | Cookie/存储隔离 | **不**隔离硬件指纹 |

---

## 实施计划

按波次落地的可执行 backlog（含 DoD、触及文件、回滚开关、PR 切片）见：

→ **[IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)**

顺序：**Wave A（关联/出口）→ Wave B（行为）→ Wave C（指纹/环境）**。未完成 A1–A5 前不要扩大 `accounts:all` 写流量。

---

## 文档维护

- 本目录为 **2026-08 独立审计** 基线；后续整改请在对应文档追加「状态：open / mitigated」与 PR 链接。
- 不覆盖、不引用 `docs/blue/01–08` 旧报告结论；若历史结论与本文冲突，以本文源码证据为准。
