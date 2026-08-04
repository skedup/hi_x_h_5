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

#### P0-1 Interact「直链 → 页内无阅读 → 一点即关」

- **证据**：`likeFeed` / `favoriteFeed` / `postComment`：`newPage` → `goto`（经 `navigateWithRetry`）→ `rateLimitedSleep(REQUEST_INTERVAL)`（默认 **≥2s**）→ 状态检查 → `click` → `page.close()`。
- **真问题**：无阅读滚动、无有机入站/referrer、一点即关；**不是**「goto 后 <1s 关页」（该描述已被现状限流否定，不可作 DoD）。
- **批处理时最强行为指纹。**

#### P0-2 点击缺多步 Fitts / hover dwell

- Explore：`scrollIntoViewIfNeeded` + `click({ force: true })`。
- Interact：`likeBtn.click()` 等走 Playwright 动作链，通常含 **scroll + 移到元素中心（多为 steps≈1 瞬移）+ down/up**。
- **正确表述**：缺的是 **多步 Fitts/Bezier 轨迹与 hover dwell**，**不是**「零 pointermove / 无 pointer 事件」。
- `force: true` 可打穿遮罩/未稳定 DOM。

#### P0-3 行为延迟为均匀族

- `randomBetween`、`jitteredSleep`（对称均匀因子）、`rateLimitedSleep`（`[base, base×1.4]`）、explore 阅读停顿均为均匀族时钟指纹。
- `jitteredSleep` ≠ 独立均匀间隔采样，但仍属均匀时钟。

#### P0-4 中文输入无 IME composition

- `typeLikeHuman` 按码点 `keyboard.type`；注释已承认无 composition。
- **B5 结论**：`typing.mode`（`XHS_MCP_AD_TYPING_MODE`）成文；完整 IME composition 为 **wontfix**（见 [B5-IME.md](./B5-IME.md)）。缓解：revise + 重尾间隔。

#### P0-5 Explore 硬跳过全部视频

- `type === 'video' → false`（`explore.ts`）。

### P1

| ID | 向量 | 证据 |
|----|------|------|
| P1-1 | Explore 私有弱滚动 ≠ 共享 `humanScroll` | 私有等距 wheel vs 共享 easing；搜索用强、浏览用弱 |
| P1-2 | `scrollIntoViewIfNeeded` 程序化滚入 | explore / interact |
| P1-3 | 找评论 `scrollBy(0.8*innerHeight)` + **固定 800ms** | `interact.ts`；须进 B6 |
| P1-4 | **Explore 与 Interact** 评论/回复 `typeLikeHuman` 无 revise | 发布正文有 revise；标签仍无 |
| P1-5 | AI 失败「很棒的分享！」/ 默认必赞帖 | `explore-ai.ts` |
| P1-6 | 打开率 `+ skippedRounds * 0.1` | 线性爬升 |
| P1-7 | reply/likeComment 不用 `rateLimitedSleep` | 与 like/fav/comment 分裂 |
| P1-8 | 发布标签无修订；清空字段 40ms 固定 sleep | `publish.ts` |
| P1-9 | `mouse.click(400, 50)` 关遮罩 | 热力尖峰 |
| P1-10 | Explore modal 内赞→评短间隔，零 `rateLimitedSleep` | 与 Interact 限流分裂 |
| P1-11 | `navigateWithRetry` 失败时 3–5s 均匀连刷同 URL | 重试指纹 |
| P1-12 | `alreadyDone` 仍 goto→读 state→关页 | 直链探活会话图 |

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

1. **Interact 会话化（直链保留）**：重尾 dwell → ≥1 次阅读滚动 → 轨迹 click（`steps≥N`）→ 动作后停留；批处理可 `keepPage`。验收**禁止**使用「<1s 关页」条款。
2. **轨迹点击原语**：多步 move + hover；`force` 仅 fallback + 审计。
3. **`heavyTailDelay`**：只替换行为等待（打字、阅读、滚动步间、Interact dwell）；**不要**默改全局 `jitteredSleep`（发布轮询等功能等待保留窄带）。
4. **IME**：Phase1 策略成文；Phase2 **wontfix**（见 [B5-IME.md](./B5-IME.md)）。
5. **Explore 视频**：按相对 feed 视频占比设接触率，不能只「打开即关凑统计」。

### P1

6. Explore 用 **独立** `SCROLL_CONFIG_EXPLORE`（勿直接套搜索的 1–2s 读延迟拖垮 duration）。
7. Explore + Interact 评论/回复开 revise；标签同理。
8. wheel 逼近可见；B6 纳入固定 800ms + explore 写间隔 `rateLimitedSleep`。
9. AI fallback 跳过；打开率改冷却/衰减。
10. **B7**：`navigateWithRetry` 重尾重试；`alreadyDone` 避免纯探测会话（见 plan）。

### 明确延后（Wave D）

- 从 explore/search **有机点入** 替代直链（可选 `entry: 'feed'`）— **D1 mitigated**（默认仍 direct；见 [D1-FEED-ENTRY.md](./D1-FEED-ENTRY.md)）。

---

## 5. 跨服务一致性矩阵（Wave B 目标态）

| 行为原语 | 搜索 | Explore | Interact | 发布 |
|----------|------|---------|----------|------|
| 滚动 | `humanScroll` | explore preset | 阅读 wheel | n/a |
| 点击 | 多步轨迹 | 多步、无 force 默认 | 多步轨迹 | 多步轨迹 |
| 键入 | n/a | revise 开 | revise 开 | revise 开 |
| 延迟 | 行为重尾 | 行为重尾 | 重尾 + rate limit | 功能窄带 + 行为重尾 |
| 入站 | 列表 | feed | **Wave B：直链+页内；Wave D：feed 点入** | 创作者页 |

---

## 6. 状态

| 项 | 状态 |
|----|------|
| 审计 | open（review 修订已合入文档） |
| Wave B 整改 | pending |
