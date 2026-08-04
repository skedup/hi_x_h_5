# B6 调用点迁移清单 · 限流与固定节拍清扫

**DoD**：生产路径不得出现「唯一节拍」300 / 500 / 800 ms（固定 `sleep(DELAYS.*)` 或裸 `scrollInterval = 800`）。

## 已迁移

| 位置 | 原节拍 | 现策略 | 用途 |
|------|--------|--------|------|
| `interact.ts` `replyComment` / `likeComment` goto 后 | `jitteredSleep(1000)` | `rateLimitedSleep(REQUEST_INTERVAL)` | 页加载 / 请求间距 |
| `interact.ts` `replyComment` / `likeComment` 读区后 | `jitteredSleep(2000)` | `heavyTailDelay(2000, { minMs: 1200, maxMs: 2800 })` | 行为 dwell |
| `interact.ts` `findCommentElement` 滚轮步间 | `sleep(800)` | `heavyTailDelay(800, { minMs: 500, maxMs: 1400 })` | 评论探测滚动 |
| `interact.ts` `findCommentElement` 滚入评论区 | `jitteredSleep(1000)` | `heavyTailDelay(1000, { minMs: 600, maxMs: 1400 })` | 行为等待 |
| `search.ts` `applySearchFilters` | `sleep(DELAYS.FILTER_PANEL_OPEN)` (500) | `heavyTailDelay(500, { minMs: 350, maxMs: 700 })` | 面板展开 |
| `search.ts` `applySearchFilters` 各 filter click | `sleep(DELAYS.FILTER_CLICK)` (300) | `heavyTailDelay(300, { minMs: 180, maxMs: 420 })` | 筛选点击 |
| `search.ts` 无新数据重试 | `sleep(500+uniform(500))` | `heavyTailDelayBetween(500, 1000)` | 滚动加载重试 |
| `explore.ts` `likeInModal` / `likeCommentInModal` 写后 | `heavyTailDelay(500, …)` | `rateLimitedSleep(REQUEST_INTERVAL)` | 写操作 / 请求门禁 |
| `explore.ts` `commentInModal` 提交后 | `jitteredSleep(2000)` | `rateLimitedSleep(REQUEST_INTERVAL)` | 写操作 / 请求门禁 |
| `interact.ts` `postComment` / `replyComment` 输入 | 无 revise | `commentTypingOptions` → `typeLikeHuman` + revise | 评论 revise |

## 刻意保留

| API | 位置 | 原因 |
|-----|------|------|
| `jitteredSleep(1000\|2000)` | `interact` 提交后 → `waitForFunction` 前 | 功能结果轮询前置等待 |
| `jitteredSleep(2000)` | `explore` 页就绪、`publish` 上传轮询等 | 功能等待（非 B6 范围） |
| `rateLimitedSleep` | `interact`/`search`/`content` goto 后 | 限流安全下限（B6 强化 reply/likeComment） |
| `heavyTailDelay(300/500/…)` | modal UI 开框、输入前后 | 行为/UI 动画（非写间隔） |

## 验证（grep DoD）

```bash
# 生产 services 下不应再出现固定 800 滚动或 sleep(DELAYS.*)
rg 'scrollInterval\s*=\s*800|sleep\(DELAYS\.|sleep\(800\)' src/xhs/clients/services/

# interact reply/likeComment 页加载应为 rateLimitedSleep
rg 'jitteredSleep\(1000\)|jitteredSleep\(2000\)' src/xhs/clients/services/interact.ts
# 预期：仅 submit 后 outcome 轮询前的 1000/2000
```

## 单测

`src/xhs/utils/heavy-tail.test.ts` · `B6`：`sampleHeavyTailMs(800, { minMs: 500, maxMs: 1400 })` 在 min≠max 时不恒为 800。
