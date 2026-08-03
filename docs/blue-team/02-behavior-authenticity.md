# 02 · 行为真实性（时机 / 键鼠 / 导航 / Explore）

> 角度：平台如何判定「这段会话不像真人在刷」。  
> 审计日期：2026-08-03 · 源码实证 · 忽略既有 `docs/blue/`。

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

---

## 2. Detection Vectors

### P0

#### P0-1 Interact「瞬移 → 单动作 → 关页」

- **证据**：`likeFeed` / `favoriteFeed` / `postComment`（`interact.ts`）：`newPage` → `goto(/explore/{id})` → 检查状态 → `click` → `page.close()`。
- **风险**：无 dwell、无阅读滚动、无 pointermove；会话寿命极短。与真人「从 feed/搜索点入并停留」分布差数量级。**批处理时最强行为指纹。**

#### P0-2 点击无 Fitts 轨迹

- Explore 打开：`scrollIntoViewIfNeeded` + `click({ force: true })`（`explore.ts:675-679`）。
- Interact like：直接 `likeBtn.click()`，无 `mouse.move`。
- **风险**：缺少 hover→move→down→up；`force: true` 可打穿遮罩/未稳定 DOM。

#### P0-3 延迟全为均匀 `Math.random`

- `randomBetween`（`utils/index.ts:190-192`）、打字间隔、`jitteredSleep`、explore 阅读停顿均为均匀区间。
- **风险**：真人间隔近似 log-normal / 重尾；均匀窄带易成时钟指纹。

#### P0-4 中文输入无 IME composition

- `typeLikeHuman` 用 `keyboard.type` 按码点直打；注释已承认无法模拟 composition（`utils/index.ts:244-246`）。
- **风险**：中文路径应有 `compositionstart/update/end`；纯 insertText 序列对发布/评论框高度异常。

#### P0-5 Explore 硬跳过全部视频

- `type === 'video' → false`（`explore.ts:256,291`）。
- **风险**：Feed 视频占比高却 0 打开，内容类型分布瞬间偏离人群基线。

### P1

| ID | 向量 | 证据 |
|----|------|------|
| P1-1 | Explore 私有弱滚动 ≠ 共享 `humanScroll` | 私有等距 wheel（`explore.ts:600-607`）；共享有 easing/回滚/鼠标（`utils/index.ts:358-426`）；搜索用强、浏览用弱 → 同账号跨场景不一致 |
| P1-2 | `scrollIntoViewIfNeeded` 瞬移视口 | explore / interact 找评论 |
| P1-3 | 找评论用 `window.scrollBy(0.8*innerHeight)` + 固定 800ms | `interact.ts:425-428` |
| P1-4 | Explore 评论 `typeLikeHuman` 无修订 | 默认 `reviseGapMin=0`；发布路径有修订 → 键入指纹分裂 |
| P1-5 | AI 失败默认「很棒的分享！」/ 默认必赞帖 | `explore-ai.ts:197-201,260-264` |
| P1-6 | 打开率兜底线性抬升 | `openRate + skippedRounds * 0.1` 封顶 0.9 |
| P1-7 | Interact 限流策略分裂 | like/fav/comment 用 `rateLimitedSleep`；reply/likeComment 用固定 jitter |
| P1-8 | 发布标签无修订；清空字段 40ms 固定 sleep | `publish.ts` |
| P1-9 | `mouse.click(400, 50)` 关遮罩 | 坐标常量热力尖峰 |

### P2

| ID | 向量 | 说明 |
|----|------|------|
| P2-1 | Content 只读也是瞬移读 state 关页 | 贡献无浏览会话导航图 |
| P2-2 | 搜索过滤器固定 300/500ms DELAYS | 无抖动 UI 节拍 |
| P2-3 | Explore 行为块状 10%/5% 概率 | 缺会话内相关（疲劳/时段） |
| P2-4 | Liveness / headless 写门禁 | **运维自保**，不改变页面内行为指纹 |
| P2-5 | 长文 typing 自适应压缩到 ~12ms/字 | 「越写越快」非人加速 |

---

## 3. 已做得好的点

1. 键盘走 CDP 可信通道（`page.keyboard.type/press`），避免 `isTrusted=false`。
2. `jitteredSleep` vs `rateLimitedSleep` 语义清晰：对称抖动 vs 保安全下限。
3. 共享 `humanScroll` 质量较高（缓动、jitter、偶发 move/回滚）；搜索已接入。
4. 发布 `fillFieldLikeHuman` 有替换语义 + 终值校验，减少残缺正文。
5. Explore 有快滑/回看/深读/快速关闭等多样性意图；写前走 liveness + 共现守卫。
6. 多处明确拒绝假事件绕过；liveness 模块自述「非检测规避」——边界清楚。

---

## 4. 整改建议

### P0 立刻做

1. **改造 Interact 会话模型**：禁止「新页→直链→一击→关」为默认；优先从 explore/search 点入；至少：重尾 dwell → 短读滚动 → Fitts 移动 → click → 短停留。批处理复用同一页。
2. **统一点击原语**：Beziér/Fitts `mousemove` 后再 down/up；`force: true` 仅 fallback 并审计。
3. **延迟改重尾**：log-normal / 截断 Pareto；保留 `rateLimitedSleep`「≥ base」。
4. **中文 IME**：评估 OS/CDP composition；或产品层显式接受「短语/英文」边界——不得假装已解决。
5. **Explore 纳入视频**：按概率短接触；删除硬 filter。

### P1

6. Explore 删除私有滚动，复用 `utils.humanScroll` + `SCROLL_CONFIG`。
7. 评论/标签启用与正文同级 revise。
8. 用 wheel 逼近可见，替代 `scrollIntoViewIfNeeded`。
9. AI fallback：失败则跳过，禁止固定话术 / 默认必赞。
10. Interact 全路径统一 `rateLimitedSleep(REQUEST_INTERVAL)`。
11. 打开率用兴趣衰减/冷却，而非线性 `+0.1`。

### P2

12. 搜索 DELAYS 改 jitter；会话级相关随机；长文宁可中断也不压到 ~12ms/字。
13. 文档将 liveness / headlessWriteGate 标为 Operational Gate，与 Behavioral Authenticity 分章。

---

## 5. 跨服务一致性矩阵（目标态）

| 行为原语 | 搜索 | Explore | Interact | 发布 |
|----------|------|---------|----------|------|
| 滚动 | `humanScroll` | 应同左 | wheel 逼近 | n/a |
| 点击 | 轨迹 click | 轨迹、无 force 默认 | 轨迹 | 轨迹 |
| 键入 | n/a | revise 开 | revise 开 | revise 开 |
| 延迟 | 重尾 | 重尾 | 重尾 + rate limit | 重尾 |
| 会话 | 列表上下文 | feed 上下文 | **禁止瞬移默认** | 创作者页 dwell |

---

## 6. 状态

| 项 | 状态 |
|----|------|
| 审计 | open |
| Wave B 整改 | pending |
