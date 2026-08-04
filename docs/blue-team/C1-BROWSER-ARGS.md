# C1 · 收紧 BROWSER_ARGS

## 变更摘要

| 项 | 说明 |
|----|------|
| 模块 | `src/xhs/clients/constants.ts` → `getBrowserArgs()` |
| 接入 | `src/xhs/clients/context.ts` `launchProfileContext` |
| 默认 | **保留** Chrome sandbox；不再传 `--deny-permission-prompts` |
| 已删 | `--disable-blink-features=AutomationControlled`（与 patchright 重复） |

## 容器 / CI 必读

在 **Docker、root、无用户命名空间** 等无法启用 Chrome sandbox 的环境，**必须**设置：

```bash
export XHS_MCP_BROWSER_NO_SANDBOX=true
```

否则 `launchPersistentContext` 可能因 sandbox 权限失败——**属预期行为**，不是 bug。

桌面 macOS / 常规 Linux 用户会话：**不要**设置该变量（默认 `false`）。

## 回滚

| 场景 | 操作 |
|------|------|
| 容器启动失败 | `XHS_MCP_BROWSER_NO_SANDBOX=true` |
| 桌面误开 no-sandbox | 取消该 env，重启进程 |

## DoD

- [x] 默认 args 无 `--no-sandbox` / `--disable-setuid-sandbox` / `--deny-permission-prompts`
- [x] `getBrowserArgs()` 随 env 动态构建，非静态常量
- [x] 单测覆盖 default vs noSandbox
- [x] 本文档写明容器/CI 必须显式 env
