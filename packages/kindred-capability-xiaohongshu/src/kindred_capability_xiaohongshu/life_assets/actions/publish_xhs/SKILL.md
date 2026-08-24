# publish_xhs

这是把已经完成的图文真正公开发布到小红书主页的一拍，不承担写作或画图。

- 只使用 Host 在当前 Activity run 中明确披露的 committed 小红书文字 Artifact 和一至九张
  committed Draw 图片；图片顺序就是发布顺序。
- 文字或图片仍在 staged、缺失、跨 Activity run 或作品还没准备好时，不要猜 ref，也不要发布。
- 调用 `xiaohongshu_publish_post` 后，只有 ToolResult 明确返回成功，才能叙述为已经发布。
- dry-run、合同失败或 UnknownSideEffect 都不算确认成功；不要自动重试，也不要假装已经发出。
- 平台可见内容不得暴露测试、AI、agent、LLM、MCP、自动化、脚本或工具调用等工程动机。
