# A1 代理硬约束 · 迁移 Runbook

多账号写（`accounts` 数组或 `all`，`capability=write`）默认要求：每账号配置可解析的 proxy，且规范化 `serverKey`（`hostname:port`，小写）互异。单账号写不强制。

## 环境变量

| 值 | 行为 |
|----|------|
| `block`（默认）/ `true` / `on` | 缺 proxy → `proxy_required`；非法 → `proxy_invalid`；同 serverKey → `proxy_shared`（skip） |
| `warn` | 仅打日志，不拦截（迁移期） |
| `off` / `false` | 关闭检查 |

```bash
# 迁移期先放行
export XHS_MCP_AD_PROXY_REQUIRED=warn

# 存量配齐后再切硬拦
export XHS_MCP_AD_PROXY_REQUIRED=block
```

## Proxy 格式

- `http://host:port`
- `http://user:pass@host:port`
- `socks5://host:1080`
- JSON：`{"server":"http://host:port","username":"...","password":"..."}`

配置入口：`xhs_add_account` / `xhs_set_account_config` 的 `proxy` 字段（非法输入直接拒绝）。

## 存量审计（手工）

1. `xhs_list_accounts` 检查每账号 `proxy` 是否为空。
2. 将各账号 proxy 规范化到 `host:port`，确认多号写批次内无重复。
3. 同 host 不同 port 视为互异；**不做 /24 匹配**（无出口 IP 解析）。
4. 配齐后去掉 `warn`，恢复默认 `block`。

## 与 C3/C8

启用地理代理后应配置账号 `timezoneId` / `locale`（必要时 `geolocation`），并确认 WebRTC 缓解开启（默认）：

- C3：[C3-LOCALE-ENV.md](./C3-LOCALE-ENV.md) — `xhs_set_account_config`
- C8：[C8-WEBRTC.md](./C8-WEBRTC.md) — `XHS_MCP_AD_WEBRTC_MITIGATION`（默认 true；有 proxy 时写 prefs）

有 proxy 却无属地时启动会 warn，避免「有代理仍漏本机时区」的半成品上量。
