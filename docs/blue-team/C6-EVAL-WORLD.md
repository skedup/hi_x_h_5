# C6 · evaluate / waitForFunction 执行世界策略

**状态**：done（`feat/blue-c6-eval-world`）

## 问题

读 `__INITIAL_STATE__` 必须主世界 `evaluate(..., false)`；DOM 操作用默认隔离世界。两套混用且裸 `waitForFunction` **无** world 开关（隐式 main），审计困难（01 P1-2 / P1-3）。

## 标准

| API | 世界 | 用途 |
|-----|------|------|
| `evalMainState` | main（`isolatedContext=false`） | 读 `__INITIAL_STATE__` 等页面全局状态 |
| `evalDom` | isolated（`true`） | 纯 DOM / 滚动度量 |
| `waitForMainState` / `waitForInitialState` | main 轮询 | 替代裸 `waitForFunction` 等状态 |
| `waitForDom` | isolated 轮询 | DOM 结果等待（如评论框清空） |

**禁止**：业务路径裸 `page.waitForFunction` 读状态；读状态时遗漏 `false`（落入隔离世界拿不到 Vue state）。

轮询等待：导航抖动（如 context destroyed）可继续；`Target closed` / page·context·browser 已关闭等致命错误**立即抛出**，避免空转至超时掩盖根因。

模块：`src/xhs/utils/page-eval.ts`（`utils/index.ts` 再导出）。

## 迁移

内容 / 搜索 / explore / interact / context / login-session / notification 的 `__INITIAL_STATE__` 路径；interact/creator 部分 DOM evaluate。

ElementHandle / Locator `.evaluate`（如点赞按钮 class）保持原样（元素作用域）。

## 验证

```bash
bun test src/xhs/utils/page-eval.test.ts
```

## DoD

- [x] `evalMainState` / `evalDom` / `waitForMainState`（+ Dom）成文并单测
- [x] 主路径不再裸用 `waitForFunction` 等 `__INITIAL_STATE__`
- [x] 01 / plan 标 mitigated
