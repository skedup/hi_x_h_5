# C7 · 文档与安装对齐 — 验收清单

**状态**：done（`docs/c7-docs-align`）

## 修复项

- [x] **stealth.js 虚述**：从 `CLAUDE.md` 项目结构中删除不存在的 `stealth.js`；全仓无「仓库自带 stealth 脚本 / addInitScript」类安装说明
- [x] **headless 默认**：`CLAUDE.md` / `README.md` / `README.en.md` / `docs/guide/installation.md` / `docs/en/guide/installation.md` 与 `config.browser.headless` 默认 **`false`** 对齐
- [x] **写门禁说明**：文档注明 `XHS_MCP_AD_HEADLESS_WRITE_GATE=true`（默认）时 headless 写操作被拒绝
- [x] **登录表述**：修正 EN quick-start / account API；登录默认强制 headful（忽略 `XHS_MCP_HEADLESS`，除非 `XHS_MCP_ALLOW_HEADLESS_LOGIN=true`）；见 `C2-LOGIN-HEADFUL.md`
- [x] **环境变量表**：`CLAUDE.md` 补齐 `config.ts` 中 Wave A/B 反检测开关，以及 C1 `XHS_MCP_BROWSER_NO_SANDBOX` / C2 `XHS_MCP_ALLOW_HEADLESS_LOGIN`- [x] **代码注释**：`auth.ts` 中 headless 说明改为「默认 false（有头）」

## 刻意保留（审计证据，非安装说明）

- `docs/blue-team/01-fingerprint-environment.md` P2-1：记录历史文档错误
- `docs/blue-team/03-multi-account-association.md` P2-5：「无 stealth 脚本」为 patchright 依赖说明

## 验证

```bash
# 无 stealth.js 作为交付物（排除蓝军审计条目）
rg -i 'stealth\.js' --glob '!docs/blue-team/0*.md' --glob '!docs/blue-team/IMPLEMENTATION-PLAN.md'

# headless 默认 false（用户文档）
rg 'XHS_MCP_HEADLESS.*\|.*\`true\`' CLAUDE.md README.md README.en.md docs/guide docs/en

# 与 config 一致
rg 'headless: parseBoolean' src/core/config.ts
```

## 不在 C7 范围

- C1 `BROWSER_ARGS` / C2 登录强制 headful 实现（后续 ticket）
- C3/C8 WebRTC、locale 等未落地 env
