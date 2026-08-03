# B2 轨迹点击调用点清单

回滚：`XHS_MCP_AD_TRAJECTORY=false`（直点，`getLastTrajectoryMeta().disabled === true`）。

| 模块 | 场景 | 说明 |
|------|------|------|
| `utils/index.ts` | `clickWithTrajectory` | Bezier/Fitts，`steps≥minSteps`（默认 5）；先 `scrollIntoViewIfNeeded`；落点 `elementFromPoint` 命中失败且 `allowForceFallback` 才 force+warn（在 mouse down 前） |
| `explore.ts` | 封面 / 赞 / 评赞 / 评论输入提交 / 关 modal | 封面 `allowForceFallback: true`（遮罩场景） |
| `interact.ts` | 赞 / 藏 / 评论 / 回复 / 评赞 | 全部 ElementHandle 轨迹点击 |
| `publish.ts` | 标签建议 / 定时 / 发布钮 / 填字段 / 关遮罩 `(400,50)` / tab / 视频 tab | Locator 与坐标目标均支持 |

未迁移（非本 ticket 范围）：`search.ts` 筛选面板点击。
