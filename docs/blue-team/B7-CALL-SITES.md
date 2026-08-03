# B7 导航重试与 alreadyDone 短会话清单

## 1. `navigateWithRetry` 重尾重试

| 项 | 说明 |
|----|------|
| 模块 | `src/xhs/utils/index.ts` |
| 采样 | `sampleNavRetryDelayMs` → 默认区间 `[3000, 5000]` ms，几何均值作 base + B1 重尾 |
| 上限 | `NAVIGATE_RETRY_MAX = 3`（含首次 goto，共 3 次尝试） |
| 回滚 | `XHS_MCP_AD_NAV_RETRY_HEAVY_TAIL=false` → 均匀 `[3000, 5000]`（迁移前行为） |
| 调用方 | `interact.ts`（like/favorite/comment/reply/likeComment）、`content.ts`（getNote） |

**禁止**：失败重试间隔固定 3–5s 均匀连刷同一 URL（节拍器指纹）。

## 2. alreadyDone 短会话

**策略**：状态已满足目标（已赞/已藏/评论已赞）时，仍保留 B3 入页阅读阶段（需读 `__INITIAL_STATE__`），但 **post-stay 改用短 dwell**（默认 ~400ms），避免「直链探活 → 完整阅读 → 秒关」纯探测会话图。

| 项 | 说明 |
|----|------|
| 模块 | `utils/interact-session.ts` `runInteractPostStay({ shortSession })` |
| 接入 | `interact.ts` `completeSession({ alreadyDone })` → like / favorite / likeComment |
| 配置 | `XHS_MCP_AD_ALREADY_DONE_SHORT=true`（默认开）；`XHS_MCP_AD_ALREADY_DONE_POST_STAY_MS=400` |
| 回滚 | `XHS_MCP_AD_ALREADY_DONE_SHORT=false` → alreadyDone 与真实互动相同 post-stay |
| meta | `session.skippedAlreadyDone === true` 可观测 |

**未改**：comment / reply 无 alreadyDone 语义，仍走完整 post-stay。

## 3. 日志区分

| 事件 | 含义 |
|------|------|
| `skipped_already_done` | 目标状态已存在，未点击；短 post-stay（若启用） |
| `interact_success` | 真实点击完成；完整 post-stay |

日志模块：`interact`（`src/xhs/clients/services/interact.ts`）。

## DoD 验收

- [x] `sampleNavRetryDelayMs` 启用时 P95 > median×1.2（非均匀）
- [x] alreadyDone 路径 `session.skippedAlreadyDone` + 更短 `postStayMs`
- [x] 日志 `skipped_already_done` vs `interact_success` 可 grep 区分
