# B4 Explore 滚动 preset + 视频 + revise 清单

回滚：`XHS_MCP_AD_EXPLORE_ALLOW_VIDEO=false`（硬跳过视频，与旧行为一致）。

| 模块 | 说明 |
|------|------|
| `constants.ts` | `SCROLL_CONFIG_EXPLORE`（MIN/MAX_DELAY 400–900ms，短于搜索） |
| `utils/index.ts` | `wheelApproachElement`：wheel 逼近 + `scrollIntoViewIfNeeded` 兜底 |
| `services/explore-helpers.ts` | 打开率冷却/衰减、视频占比与接触率（纯逻辑，可单测） |
| `services/explore.ts` | 删私有 `humanScroll` → `exploreHumanScroll` + 共享 `humanScroll` |
| `services/explore.ts` | `allowVideo` 配置；按 feed 视频占比接触；视频禁止 quick-close |
| `services/explore.ts` | `computeEffectiveOpenRate` 替代 `skippedRounds * 0.1` |
| `services/explore.ts` | 评论 `typeLikeHuman` 传 revise（`exploreCommentTypingOptions`） |
| `config.ts` | `antiDetect.explore.allowVideo` ← `XHS_MCP_AD_EXPLORE_ALLOW_VIDEO` |

DoD：Explore 滚动 preset 可检；视频接触率与 feed 占比相关；评论有 revise；打开率开后有冷却；封面打开前 wheel 逼近。

未做（Wave B 其他项）：B6 modal 写间隔 rate limit；B7 alreadyDone / navigateWithRetry。
