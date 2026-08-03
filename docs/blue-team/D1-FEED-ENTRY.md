# D1 · Interact `entry: 'feed' | 'direct'` 有机点入

**状态**：done（`feat/blue-d1-d2`）

## 决策

- **默认 `direct`**：与现网一致，`buildNoteUrl` + `navigateWithRetry`
- **可选 `entry: 'feed'`**：从 explore 首页滚动找封面（`href*=noteId`）→ 轨迹点击进帖/modal
- 封面不可见或点击失败 → **回退 direct** + `log.warn('feed_entry_fallback')`，会话 meta 标 `entryFallback: true`

## 配置

| 变量 / 参数 | 默认 | 说明 |
|-------------|------|------|
| `XHS_MCP_AD_INTERACT_ENTRY` | `direct` | 全局默认 |
| MCP / `sessionOpts.entry` | （覆盖全局） | `direct` \| `feed` |

## 模块

- `src/xhs/utils/interact-entry.ts` — `resolveInteractEntry` / `openNoteForInteract` / `tryOpenNoteFromFeed`
- Interact 各写方法经 `openNoteForInteract`；meta：`entry` / `entryFallback`
- `tools/interaction.ts` 各写工具可选 `entry`

## 验证

```bash
bun test src/xhs/utils/interact-entry.test.ts
```

## DoD

- [x] `entry:'direct'` 行为与现网一致
- [x] `entry:'feed'` 封面可见时不直链 goto；不可见时回退且可观测
- [x] 单测 mock page（不依赖真站）

## 刻意不做

- 默认改 feed（1B）
- 首版 search + `feedKeyword`（固定 explore 首页）
