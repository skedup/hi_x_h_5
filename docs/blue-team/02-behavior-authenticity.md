# 02 · 行为真实性（时机 / 键鼠 / 导航 / Explore）

> 角度：平台如何判定「这段会话不像真人在刷」。  
> 审计日期：2026-08-03 · 源码实证 · 忽略既有 `docs/blue/`。  
> Review： [行为 review](0311295f-d10a-4c72-ad56-df51121c63fa) `request-changes` → 本修订已吸收。

---

## 1. 范围

| 模块 | 路径 |
|------|------|
| 拟人工具 | `src/xhs/utils/index.ts`（`typeLikeHuman` / `humanScroll` / jitter） |
| 互动 | `src/xhs/clients/services/interact.ts` |
| 浏览 | `src/xhs/clients/services/explore.ts` |
| 发布 | `src/xhs/clients/services/publish.ts` |
| AI 决策 | `src/core/explore-ai.ts` |
| 运维门禁 | `src/core/liveness.ts`（**非**行为拟人） |

**范围边界**：Wave B 默认保留 Interact **直链** `goto(/explore/{id})`，补齐页内 dwell/滚动/多步轨迹。Wave D1 已落地可选 `entry: 'feed'`（默认仍 `direct`）→ [D1-FEED-ENTRY.md](./D1-FEED-ENTRY.md)。

---

## 2. Detection Vectors

### P0

#### P0-1 Interact「直链 → 页内无阅读 → 一点即关」 — **mitigated（B3）**

- **原证据**：`likeFeed` / `favoriteFeed` / `postComment`：goto → 短等 → click → close。
- **现状**：默认开启 Interact 会话化（重尾 pre-dwell → ≥1 阅读 scroll → 轨迹 click → post-stay）。回滚：`XHS_MCP_AD_INTERACT_SESSION=false`。见 [B3-CALL-SITES.md](./B3-CALL-SITES.md)。
- **残余**：默认仍直链入站；有机 feed 点入见 **D1**（可选 `entry:feed`）。

#### P0-2 点击缺多步 Fitts / hover dwell — **mitigated（B2）**

- **现状**：`clickWithTrajectory`（默认 `minSteps≥5`）；`force` 仅 fallback。见 [B2-CALL-SITES.md](./B2-CALL-SITES.md)。回滚：`XHS_MCP_AD_TRAJECTORY=false`。

#### P0-3 行为延迟为均匀族 — **mitigated（B1，行为路径）**

- **现状**：行为等待走 `heavyTailDelay`（默认开）；`jitteredSleep` 保留给功能轮询；`rateLimitedSleep` 仍 ≥ base。见 [B1-CALL-SITES.md](./B1-CALL-SITES.md)。

#### P0-4 中文输入无 IME composition — **wontfix（B5 Phase2）**

- `typeLikeHuman` 按码点；`typing.mode=ime` 降级 direct + warn。见 [B5-IME.md](./B5-IME.md)。

#### P0-5 Explore 硬跳过全部视频 — **mitigated（B4）**

- 默认允许视频接触率路径；回滚：`XHS_MCP_AD_EXPLORE_ALLOW_VIDEO=false`。见 [B4-CALL-SITES.md](./B4-CALL-SITES.md)。

### P1

| ID | 向量 | 证据 | 状态 |
|----|------|------|------|
| P1-1 | Explore 私有弱滚动 ≠ 共享 `humanScroll` | 曾私有等距 wheel | **mitigated（B4）** explore preset |
| P1-2 | `scrollIntoViewIfNeeded` 程序化滚入 | explore / interact | 部分缓解（轨迹前仍可能用） |
| P1-3 | 找评论固定 800ms | `interact.ts` | **mitigated（B6）** |
| P1-4 | 评论/回复无 revise | explore/interact | **mitigated（B6）** |
| P1-5 | AI 失败固定句 / 默认赞帖 | `explore-ai.ts` | **mitigated（A4）** |
| P1-6 | 打开率线性爬升 | explore | 部分（冷却策略见实现） |
| P1-7 | reply/likeComment 限流分裂 | interact | **mitigated（B6）** |
| P1-8 | 发布标签无修订；40ms sleep | `publish.ts` | 低优残余 |
| P1-9 | `mouse.click(400, 50)` 关遮罩 | 热力尖峰 | 低优残余 |
| P1-10 | Explore modal 写间隔 | explore | **mitigated（B6）** |
| P1-11 | `navigateWithRetry` 均匀重试 | interact | **mitigated（B7）** |
| P1-12 | `alreadyDone` 纯探测会话 | interact | **mitigated（B7）** |

### P2

| ID | 向量 | 说明 |
|----|------|------|
| P2-1 | Content 只读瞬移读 state | 导航图 |
| P2-2 | 搜索过滤器固定 300/500ms | 无抖动 |
| P2-3 | Explore 块状 10%/5% | 缺疲劳/时段相关 |
| P2-4 | Liveness / headless 写门禁 | Operational Gate |
| P2-5 | 长文 typing 可压到 ~12ms/字 | 非人加速 |
| P2-6 | dwell 多为纯 sleep，无微动 | 阅读段缺视线跟随 |

---

## 3. 已做得好的点

1. 键盘 CDP 可信通道；发布路径有 Backspace 修订。
2. `jitteredSleep` vs `rateLimitedSleep` 语义清晰。
3. 共享 `humanScroll` 质量较高；搜索已接入。
4. 发布 `fillFieldLikeHuman` 替换语义 + 终值校验。
5. Explore 有快滑/回看/深读等意图；写前 liveness + 共现守卫。
6. liveness 自述「非检测规避」。

---

## 4. 整改建议

### P0（Wave B）

1. **Interact 会话化（直链保留）** — **done（B3）**；验收禁止「&lt;1s 关页」假条款。
2. **轨迹点击原语** — **done（B2）**。
3. **`heavyTailDelay`** — **done（B1）**；勿默改全局 `jitteredSleep`。
4. **IME**：Phase1 成文；Phase2 **wontfix**（[B5-IME.md](./B5-IME.md)）。
5. **Explore 视频** — **done（B4）**。

### P1

6. Explore `SCROLL_CONFIG_EXPLORE` — **done（B4）**。
7. Explore + Interact 评论/回复 revise — **done（B6）**。
8. wheel / 写间隔 — **done（B6）**。
9. AI fallback 跳过 — **done（A4）**。
10. **B7**：`navigateWithRetry` / `alreadyDone` — **done**。

### 明确延后 / 已落地

- 有机点入 — **D1 mitigated**（默认仍 direct；见 [D1-FEED-ENTRY.md](./D1-FEED-ENTRY.md)）。

---

## 5. 跨服务一致性矩阵（目标态 ≈ 现状）

| 行为原语 | 搜索 | Explore | Interact | 发布 |
|----------|------|---------|----------|------|
| 滚动 | `humanScroll` | explore preset | 阅读 wheel | n/a |
| 点击 | 多步轨迹 | 多步、无 force 默认 | 多步轨迹 | 多步轨迹 |
| 键入 | n/a | revise 开 | revise 开 | revise 开 |
| 延迟 | 行为重尾 | 行为重尾 | 重尾 + rate limit | 功能窄带 + 行为重尾 |
| 入站 | 列表 | feed | 默认直链+页内；可选 `entry:feed`（D1） | 创作者页 |

---

## 6. 状态

| 项 | 状态 |
|----|------|
| 审计 | closed（P0 可缓解项 mitigated；IME = wontfix） |
| Wave B 整改 | **done**（B1–B7；B5 Phase2 wontfix） |
