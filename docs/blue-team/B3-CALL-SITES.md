# B3 Interact 会话化清单

回滚：`XHS_MCP_AD_INTERACT_SESSION=false`（跳过入页阅读 dwell / 阅读滚动 / 加长后停留；仍保留 B1 短 dwell 与 B2 轨迹）。

模板：`goto → rate limit → 重尾 pre-dwell → ≥1 humanScroll(wheel) → 轨迹 click → 重尾 post-stay → close`。

`keepPage: true`：不关页，登记到 `InteractService`；批处理结束后必须调用 `releaseKeptInteractPages()`（或 `releaseKeptPages()`），否则会堆积 orphan tab。可用 `getKeptInteractPageCount()` 观测。

阅读阶段之后的失败早退（按钮找不到等）也会跑 `runInteractPostStay` 并附带 `session` meta。

| 模块 | 说明 |
|------|------|
| `utils/interact-session.ts` | `runInteractReadingPhase` / `runInteractPostStay` / `getLastInteractSessionMeta` |
| `interact.ts` | like / favorite / comment / reply / likeComment 全路径接入；`releaseKeptPages` |
| 配置 | `preDwellMs` 默认 1500；`postStayMs` 默认 1200；`minReadScrolls` 默认 1 |

DoD（单次 like 默认可观测）：`session.preDwellMs > 0`、`session.readScrollCount ≥ 1`、轨迹 `steps≥N`（B2）、`session.postStayMs` 采样自配置；**禁止**仅用「goto 后 &lt;1s 关页」验收。

未做（Wave D / B7）：有机 feed 点入；`alreadyDone` 短探测专项治理。
