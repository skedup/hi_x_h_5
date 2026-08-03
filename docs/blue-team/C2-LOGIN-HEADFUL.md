# C2 · 登录强制 headful

登录建档（`xhs_add_account` / `LoginSessionManager.createSession`）默认**忽略**全局 `XHS_MCP_HEADLESS`，强制以 headful + `viewport: null` 启动 Chrome，避免 headless + 固定 1920×1080 的 `screen≈viewport` 指纹组合。

## 环境变量

| 变量 | 默认 | 行为 |
|------|------|------|
| `XHS_MCP_HEADLESS` | `false` | 全局浏览器 headless；**不影响登录**（除非下方逃生口开启） |
| `XHS_MCP_ALLOW_HEADLESS_LOGIN` | `false` | `false`：登录强制 headful；`true`：登录可沿用 `XHS_MCP_HEADLESS` |

```bash
# 默认：即使全局 headless=true，add_account 仍 headful
export XHS_MCP_HEADLESS=true
# 登录仍为 headful（allow 默认 false）

# CI/无图形环境逃生口（不推荐生产）
export XHS_MCP_ALLOW_HEADLESS_LOGIN=true
export XHS_MCP_HEADLESS=true
```

## 无 DISPLAY（Linux 服务器）

headful 启动前会检查图形环境。Linux 上若既无 `DISPLAY` 也无 `WAYLAND_DISPLAY`，登录会 fail-closed 并提示：

1. **推荐**：用 Xvfb 提供虚拟显示后再登录  
   `xvfb-run -a bun run start:http`
2. **逃生口**：`XHS_MCP_ALLOW_HEADLESS_LOGIN=true`（允许 headless 登录，恢复旧行为）

macOS / Windows 不做 DISPLAY 检查。

## 实现要点

- `resolveLoginHeadless()`（`config.ts`）：`allow=false` 时恒返回 `false`
- `launchProfileContext(..., { forceHeadful?: boolean })`（`context.ts`）：可选强制 headful
- headful 时 `viewport: null`；headless 时固定 1920×1080
- `headlessWriteGate` 不变：写操作仍拒绝 headless

## DoD 自检

```bash
# 单元测试
bun test src/core/config.test.ts

# 期望：HEADLESS=true + allow=false → resolveLoginHeadless() === false
```
