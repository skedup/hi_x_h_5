# B1 调用点迁移清单

`heavyTailDelay` / `sampleHeavyTailMs` **仅**用于行为等待。功能等待保留 `jitteredSleep`；限流保留 `rateLimitedSleep`（`≥ base`）。

回滚：`XHS_MCP_AD_HEAVY_TAIL=false`  
- 调用方传了 `{ minMs, maxMs }` → 在该区间均匀  
- 未传 bounds → `[0.8×base, 1.2×base]`

## 已迁移（行为）

| 位置 | 用途 |
|------|------|
| `utils/index.ts` `typeLikeHuman` | 键间 / 修订 / 停顿 |
| `utils/index.ts` `humanScroll` | 滚轮步间、阅读停顿、回看（search 经此间接受益） |
| `services/interact.ts` | like / favorite / 评论输入前后 / 回复开框 / 评赞后 dwell（~300–1000ms） |
| `services/explore.ts` | feed 滑动步间、回看、modal 阅读/快关、滚轮步间、modal UI dwell（300/500，夹在原 jitter 带） |
| `services/explore.ts` | feed/modal 长阅读经 `sampleHeavyTailMs` + `sleepAbortable` |

## 刻意保留

| API | 位置示例 | 原因 |
|-----|----------|------|
| `jitteredSleep` | `publish.ts` 上传/发布轮询；`explore`/`auth`/`creator` 页就绪 ~2s；interact 提交确认 1–2s、页加载 | 功能等待 |
| `rateLimitedSleep` | `interact`/`search`/`content` 的 `REQUEST_INTERVAL` | 限流安全下限 |
| `sleep` 固定 | ~~`interact.findCommentElement` 滚动探测间隔~~ | B6 已迁 `heavyTailDelay(800, …)` |
| `sleep` | `publish` 打字辅助极短 40ms | 功能微等待 |

## 后续（非 B1）

- ~~B6：搜索 `DELAYS`、explore modal 写间隔 rate limit~~（见 [B6-CALL-SITES.md](./B6-CALL-SITES.md)）
- B3：Interact 会话化 dwell 继续用 `heavyTailDelay`
