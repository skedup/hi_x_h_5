息屏专项蓝军检验（脱敏结果）

日期：2026-07-15（Asia/Singapore）

## 结论

项目实际 Patchright headful 配置可在 macOS 显示器处于 asleep 状态时启动，并持续接收自动化输入及发出页面请求；启动 Chrome 没有唤醒显示器。这新增的是“显示器关闭期间仍有连续账号行为”的上下文一致性风险，不是一个网页可无权限直接读取的确定性指纹。

风险评级：P1（自动互动/发布），单账号只读为 P2。置信度：OS 状态与本地请求链为高；平台是否采集/使用相关上下文为低到中。

## 实验边界

- 只创建全新的 0700 临时 profile，未读取、复制或启动真实 profile。
- 使用项目实际 `channel: 'chrome'`、固定 viewport 和 `BROWSER_ARGS`。
- 另加 DNS sinkhole、非 loopback route abort、背景联网禁用。
- 页面仅位于 `127.0.0.1`；未访问小红书或任何外站。
- 未申请通知、空闲检测或其他敏感权限。
- 35 秒窗口内，每 5 秒注入一次本地输入并向本地端点发请求，用于验证息屏期间执行能力。

## OS 实测

| 时点 | CoreGraphics | `pmset` 最新显示事件 |
| --- | --- | --- |
| 启动前 | asleep=true | off |
| Chrome 启动后 | asleep=true | off |
| 窗口中段 | asleep=true | off |
| Chrome 关闭后 | asleep=true | off |

最新显示事件始终是 19:30 的 turned off；实验期间没有新的 turned on。系统本身因既有 `caffeinate` 断言未进入整机睡眠，这与“显示器 asleep、计算继续运行”相容。

## 浏览器与网络实测

- headful Chrome 成功启动、加载本地页面并接收输入。
- 息屏窗口内记录到 1 个本地文档请求和 7 个本地 fetch；服务端收到对应 1 个 GET 与 7 个 POST。
- 外部页面请求为 0，route abort 计数为 0；DNS sinkhole 与禁用背景联网参数同时生效。
- 因收尾采集函数没有保留在 Patchright evaluate 所在的执行世界，rAF、`visibilityState`、focus、权限、GPU 和精确 timer 分布未成功回收。不得将这些字段写成已验证事实。

## 新增风险

1. **显示器关闭不构成自动化熔断。** 实测项目配置在显示器 asleep 时继续运行，且启动 headful 不会自动唤醒或暂停；因此夜间/无人值守窗口仍可能产生连续互动和发布。
2. **账号行为与设备使用上下文可能矛盾。** 如果页面 SDK、浏览器/客户端遥测或平台服务端能将长时间低人工活动与高频互动关联，息屏期间持续行为会增加异常评分。网页通常不能无权限直接读取 macOS 的显示电源状态，因此这是组合推断，不是单字段检测。
3. **项目参数主动阻止后台节流。** `--disable-background-timer-throttling`、`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding` 会让息屏/遮挡期间任务更稳定地持续。这对可用性有利，但会放大无人值守操作的持续性。
4. **headful 不等于有人在场。** 本轮证明 headful Chrome 可以在物理显示器 asleep 时完成页面请求和输入，不能将 headful 作为人工在环的门禁。

## 未新增或未证实

- 未证实息屏会改变 UA、WebGL、DPR、权限或其他稳定指纹。
- 未证实 `document.visibilityState` 在息屏后变为 hidden；本轮对应采集失败。
- 未证实平台能读取 macOS 的显示电源状态，也未验证平台私有 SDK、风控权重或处罚阈值。
- 未观察到启动 Chrome 导致显示器被唤醒。

## 误报来源

- macOS 上关闭显示器但整机保持运行是正常场景，例如外接显示、视频/音频、下载、远程会话或 `caffeinate`。
- 网站在显示器关闭时继续执行定时器或网络任务本身并不等于自动化。
- 只有与持续输入、高频互动、跨账号同步、固定时序或全天候活动组合时，风险判断才明显增强。

## 整改门禁

1. 写操作必须有最近一次真实人工确认；检测到长时间无人工输入、会话锁定或显示器 asleep 时只允许停止/shadow，不自动互动或发布。
2. 去除三个禁止后台节流参数，除非只读任务有明确业务必要；写操作不能依赖这些参数维持无人值守运行。
3. 增加全局时段预算、每日/小时配额、异常状态熔断,不要增加随机延迟或伪造活跃状态作为修复。
4. 在发布/评论前记录低敏审计：批准主体、批准时间、操作类型、账号和策略决策；不要保存高熵设备原值。
5. 动态放行门禁需补测：屏幕 on/off 转换期间的 visibility/focus/rAF/timer、锁屏与整机 sleep、去掉后台节流参数的对照，以及真实人工 Chrome 基线；仍只在本地页面执行。

## 临时产物（供主审清理）

- `/private/tmp/xhs-screen-off-profile-mPnEo1/`（0700，全新 Chrome profile）
- `/private/tmp/xhs-screen-off-probe.mjs`
- `/private/tmp/xhs-screen-probe.c`
- `/private/tmp/xhs-screen-probe`
- `/private/tmp/xhs-screen-off-blue-team-findings.md`

仓库文件未修改。
