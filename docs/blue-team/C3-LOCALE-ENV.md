# C3 · timezone / locale / geolocation

**状态**：done（`feat/blue-c3-c8`）

## 问题

launch 仅传 headless/args/proxy，无账号级时区/语言/坐标；有地理 proxy 时 `Intl` / `navigator.languages` / geo 与出口不一致（01 P0-1 / P1-1）。

## 方案

| 字段 | 存储 | Playwright |
|------|------|------------|
| `timezoneId` | `accounts.timezone_id` | `timezoneId` |
| `locale` | `accounts.locale` | `locale`（→ languages / Accept-Language） |
| `geolocation` | `accounts.geolocation` JSON | `geolocation` + `grantPermissions(['geolocation'])` |

- **禁止**无 `timezoneId`+`locale` 时配置 geo（`forbid blind geo fill`）
- **不**从 proxy 字符串瞎填属地；有 proxy 缺属地时 warn
- **不**默认伪造 UA

## MCP

`xhs_set_account_config` 增加 `timezoneId` / `locale` / `geolocation`（空串或 `null` 可清除）。  
`xhs_list_accounts` 回显上述字段。

## 模块

- `src/core/locale-env.ts` — 校验 / merge / `buildPlaywrightLocaleOptions`
- `src/xhs/clients/context.ts` — launch 接线 + grantPermissions
- DB migrate：`ALTER TABLE accounts ADD COLUMN timezone_id|locale|geolocation`

## 验证

```bash
bun test src/core/locale-env.test.ts
```

## DoD

- [x] DB + set/list
- [x] launch 传入 timezone/locale/geo
- [x] geo 时 grantPermissions
- [x] geo 无 locale/tz 被拒
- [x] 单测覆盖校验与 options 组装
