# C5 · 登出归档 profile

**状态**：done（`feat/blue-c5-logout-archive`）

## 问题

旧 `deleteCookies` 仅 `context.clearCookies()` + close，on-disk profile（IndexedDB / LocalStorage / ServiceWorker 等）仍在，与真人清会话不符（01 P1-5）。

## 变更

| 项 | 说明 |
|----|------|
| `archiveProfileDir` | `profile.ts`：rename → `{profileId}.archived-{ts}`（对齐 finalizeLoginProfile） |
| `BrowserContextManager.deleteCookies` | **先 close 再归档**；不再调用 `clearCookies`；JSDoc `@deprecated` 旧语义 |
| `xhs_delete_cookies` | `removeClient` + `archiveProfileDir` + 清 DB state；描述标明非「只清 Cookie」 |
| 术语 | 归档的是 profile **内持久化会话标识**，非硬件指纹 |

## DoD

- [x] 登出后原 profile 路径不存在，内容在 `.archived-*`
- [x] 不再依赖 Playwright `clearCookies` 作为登出手段
- [x] 单测覆盖归档 / 缺省 no-op

## 验证

```bash
bun test src/core/profile.test.ts
```

## 回滚

恢复 `clearCookies` + close 即回退（不推荐）；工具名 `xhs_delete_cookies` 保留兼容。
