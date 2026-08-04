# C4 · 配图下载对齐 downloadFile

**状态**：done（`feat/blue-c4-image-download`）

## 问题

发布 `images` 含 HTTP URL 时，旧路径 `downloadImageFromUrl` 走 Node 裸 `fetch`：无 Cookie、无 Referer/Sec-Fetch、不走账号 proxy → 与浏览会话 egress 分裂（01 P1-4）。

## 变更

| 项 | 说明 |
|----|------|
| 共享出口 | `downloadFile` 抽至 `src/core/account-download.ts`；`tools/download.ts` 再导出 |
| 配图 | `resolveImagePaths` / `downloadImageFromUrl` 必经 `APIRequestContext` |
| 发布 | `publishContent` 先 `ensureContext`，再 `resolveImagePaths(..., this.ctx.request)` |
| Fail-closed | 有 HTTP URL 但无 `apiRequest` → 抛错，禁止裸 fetch 回退 |
| 范围外 | Gemini `fetchAndCompressImage` 仍为服务端侧拉图；代码注释标明非浏览 egress |

## DoD

- [x] 配图请求头与账号 `downloadFile` 一致（Referer + Sec-Fetch）
- [x] 发布路径经账号 context（Cookie + proxy）
- [x] 业务配图无裸 `fetch`
- [x] 单测：本地路径 / fail-closed / 带头下载

## 验证

```bash
bun test src/core/account-download.test.ts src/xhs/utils/resolve-image-paths.test.ts
```

## 回滚

恢复 `downloadImageFromUrl` 裸 fetch 即回退（不推荐）；无独立 env 开关。
