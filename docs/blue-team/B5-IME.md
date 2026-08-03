# B5 · IME / 键入策略

## Phase1：`typing.mode`

| 值 | 含义 |
|----|------|
| `direct`（默认） | 按 Unicode 码点 `page.keyboard.type` + 重尾间隔 + 可选 revise（Backspace 重输） |
| `ime` | **请求**真实中文 IME composition；当前 **wontfix**，运行时降级为 `direct` 并 warn 一次 |

环境变量：`XHS_MCP_AD_TYPING_MODE=direct|ime`（别名：`codepoint`/`keyboard`→direct，`composition`→ime）。

代码入口：`config.antiDetect.typing.mode` · `resolveTypingMode()` · `typeLikeHuman({ mode })`。

## 风险（为何不能假装有 IME）

1. **可信通道限制**：本项目坚持 CDP Input / Playwright `keyboard.*`（`isTrusted=true`）。真实系统 IME 的 `compositionstart` / `compositionupdate` / `compositionend` 与候选窗状态机不在该 API 可完整复现范围内。
2. **假 composition 更糟**：用 `dispatchEvent` 合成 composition 会得到 `isTrusted=false`，比「无 composition + 有 revise」更易被指纹。
3. **产品接受面**：评论/发布路径已用 revise + 间隔方差满足可测量行为 DoD；完整 IME 仿真需 OS 级输入法或专用驱动，超出 MCP 浏览器自动化边界。

## Phase2 结论：`wontfix`

**书面 wontfix**：不实现经 CDP 的完整中文 IME composition 事件流。

缓解措施（已落地）：

- `direct` 模式 + revise（删除/重输）
- 重尾字间延迟（B1）
- 配置显式暴露 `typing.mode`，避免「静默假装有 IME」

若未来要真正 IME：需独立 PoC（宿主机 IME + 可见 headful + 非 headless 写路径），作为新 ticket，不在本 Wave B DoD 内。

## 回滚

默认即为 `direct`。设置 `XHS_MCP_AD_TYPING_MODE=ime` 仅触发降级 warn，不改变输入路径。
