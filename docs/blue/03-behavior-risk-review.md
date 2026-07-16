蓝军行为风控审查结果如下。未修改仓库文件。

说明：以下“事实”来自当前 `src/` 静态代码；“平台检测特征”是基于常见 Web 行为风控的推断，并不代表已知小红书内部规则。严重度表示被识别、账号串用或形成群控特征的综合风险。

## P0

### P0-1 多账号实际共用同一个持久化 Chrome Profile，账号状态未被加载

代码证据：

- `src/core/config.ts:169-172`：全局唯一 `browser-profile` 路径。
- `src/xhs/clients/context.ts:24-29`：所有客户端均以该路径调用 `launchPersistentContext`，并固定 `1920x1080`。
- `src/core/account-pool.ts:71-76`：每个账号虽然从 DB 传入独立 `state`。
- `src/xhs/clients/context.ts:24-48`：启动 Context 时完全没有使用 `options.state`。
- `src/xhs/clients/context.ts:193-203`：`saveState()` 存在，但当前仓库没有调用点。
- `src/core/multi-account.ts:243-247`：不同账号默认并行启动操作。

事实：

- 账号池声明的每账号 storage state 实际没有灌入浏览器。
- 所有账号共享同一 user-data-dir。
- 同时启动多个 persistent context 时，Chrome 通常会发生 profile singleton 冲突；若串行成功，则各账号依旧共享 Cookie、localStorage、设备历史。

平台可构造的特征（推断）：

- 多个逻辑账号出现同一 Cookie/profile/device 历史。
- DB 中指定账号与页面实际登录账号不一致。
- 多账号在相同设备/IP/浏览器指纹上切换，形成高密度账号关联图。
- 并行操作可能呈现连续 profile 启动失败、重新登录或会话漂移。

风险场景：以账号 B 调用点赞/评论，页面实际仍登录账号 A；或者多个账号共用一个设备身份，被平台合并为群控实体。

置信度：代码缺陷高；最终平台观测结果中高，取决于 Chrome/Patchright 的 profile singleton 行为。

防御性建议：

- 每账号使用物理隔离的 user-data-dir，路径必须包含 accountId。
- 启动后先读取页面 userId，并与 DB accountId 对应的 profile 做强校验；不一致时禁止一切写操作。
- 不再把 DB `state` 当成已生效状态；要么正确加载独立 storage state，要么只使用独立 persistent profile。
- 多账号可变操作增加全局互斥与账号—设备—代理固定绑定。
- 在完成隔离前禁用 `accounts`/`all` 的写操作。

### P0-2 多个高风险交互显式使用脚本生成的非可信事件

代码证据：

- `src/xhs/clients/services/explore.ts:529-535`：通过 `HTMLElement.click()` 打开笔记。
- `src/xhs/clients/services/explore.ts:690-693`：直接设置 `textContent`，再 `dispatchEvent(new Event('input'))`。
- `src/xhs/clients/services/interact.ts:315-320`：回复评论同样直接改 `textContent` 并派发 input。
- `src/xhs/clients/services/interact.ts:529-534`：点赞评论显式构造 `new MouseEvent('click')` 并 `dispatchEvent`。

事实：浏览器脚本构造的这些事件 `isTrusted=false`，且没有真实的 pointerdown → pointerup → click 或 keydown → input → keyup 链。

平台可构造的特征（推断）：

- 写操作事件的 `isTrusted=false` 比例。
- click 前不存在鼠标移动、pointerdown、pointerup。
- 评论输入一次性出现完整字符串，无逐字键盘事件、composition 事件和编辑轨迹。
- DOM 内容变化与用户输入事件时间线不一致。

风险场景：探索评论、回复、评论点赞和笔记 modal 打开均可被页面前端直接标记为程序事件。

置信度：高。

防御性建议：

- 点赞、评论、发布等副作用操作改为官方支持接口，或要求真人在可见页面确认并完成。
- 禁止通过 `evaluate()` 注入内容或派发交互事件。
- 平台侧蓝军测试应专门记录 `isTrusted`、pointer/keyboard 事件链完整性。
- 在无法保证可信交互来源前，关闭自动评论与自动点赞。

### P0-3 多账号写操作默认同时打向同一对象，形成强群控关联

代码证据：

- `src/core/multi-account.ts:160-162`：文档明确默认并行。
- `src/core/multi-account.ts:243-247`：`Promise.all` 同时执行。
- `src/tools/interaction.ts:225-245`：相同 noteId/xsecToken 同时点赞。
- `src/tools/interaction.ts:274-293`：相同目标同时收藏。
- `src/tools/interaction.ts:322-343`：多个账号发布完全相同的评论内容。
- `src/tools/interaction.ts:419-438`：多个账号同时点赞同一评论。
- `src/tools/draft.ts:582-602`：同一个草稿默认并行发布到多个账号。
- `src/tools/publish.ts:97-131`：视频虽串行，但账号间没有冷却或节律间隔。

平台可构造的特征（推断）：

- 多账号在毫秒/秒级窗口内对同一 note/comment 执行同动作。
- 多账号提交完全相同评论、标题、正文、图片或视频。
- 同一个 `xsecToken` 被不同账号/IP/device 重用。
- 账号之间形成高度同步的共现边和内容指纹。

风险场景：`accounts:"all"` 一次性点赞、评论或发布，容易成为账号集群关联的直接证据。

置信度：高。

防御性建议：

- 禁止多账号批量点赞、收藏、评论等互动动作。
- 发布也应默认单账号，跨账号发布必须人工逐项审批并做版权/重复内容检查。
- 对相同 target、内容哈希和媒体哈希建立跨账号硬拦截。
- `xsecToken` 只允许在获取它的账号与浏览会话内使用。
- 建立全局而非仅账号级的副作用预算和并发上限。

## P1

### P1-1 “请求间隔”不是全局限流器，且大量固定时钟形成尖峰

代码证据：

- `src/core/config.ts:30-33`：整数配置无最小值校验，零或负数可进入系统。
- `src/core/config.ts:81-82`：默认间隔固定为 2000ms。
- `src/xhs/clients/services/search.ts:61-67`
- `src/xhs/clients/services/content.ts:49,169,258`
- `src/xhs/clients/services/interact.ts:49,130,205`

事实：`REQUEST_INTERVAL` 只是每个页面导航后的固定 sleep，不是跨工具、跨页面、跨账号的请求调度器。账号锁释放后也没有冷却。

检测特征（推断）：

- 事件间隔直方图在 300/500/1000/2000/3000ms 形成明显尖峰。
- 多页面、多账号仍可并发请求。
- 配置为 0 时写操作几乎无节流。

置信度：高。

整改：建立中心化限流、日配额、连续失败熔断；配置增加安全下限；写操作按服务条款保守限速，不能把随机 sleep 当成风控策略。

### P1-2 没有昼夜节律、每日预算或账号年龄/历史自适应

代码证据：

- `src/tools/explore.ts:103-111`：仅校验时长和三个概率。
- `src/xhs/clients/services/explore.ts:127-135`：默认参数固定。
- `src/xhs/clients/services/explore.ts:170-189`：收到请求后立即运行到精确结束时间。
- `src/core/multi-account.ts:66-151`：执行入口无时段、额度或历史行为检查。
- 仓库中没有 daily quota、cooldown、circadian scheduler 的实现。

检测特征（推断）：

- 账号可 24×7 重复运行固定 60 秒 session。
- 夜间活跃比例、连续在线时长、每小时互动率长期稳定。
- 新老账号使用完全相同的行为参数。

置信度：高。

整改：自主互动默认关闭；增加账号级日/周预算、静默时段、连续会话上限和人工审批，不允许仅靠调用方控制概率。

### P1-3 探索行为是平稳的硬编码概率模型，与内容长度和账号历史无关

代码证据：

- `src/xhs/clients/services/explore.ts:196-230`：10% 快滑、5% 回滚、1–3 次滚动、3–8 秒阅读、10% 长停留。
- `src/xhs/clients/services/explore.ts:261-264`：连续跳过后打开概率机械增加，每轮 +0.1。
- `src/xhs/clients/services/explore.ts:326-341`：15% 快关、3–8 秒阅读、10% 深读 10–20 秒。
- `src/xhs/clients/services/explore.ts:346-405`：固定顺序为“读 → 点赞决策 → 评论决策 → 关闭”。
- `src/xhs/clients/services/explore.ts:269-272`：始终排除视频。

检测特征（推断）：

- 所有账号共享相同离散概率与有界均匀分布。
- 阅读时长与正文长度、图片数、评论数、视频长度无相关性。
- 视频打开率恒为零。
- 行为转移矩阵长期稳定，固定先赞后评。

置信度：高。

整改：不要继续追求“更像真人”的概率伪装；应减少自主行为范围，探索仅用于只读采集，互动转为人工决定。平台侧可用 dwell-content 相关性和 Markov 序列检测验证。

### P1-4 滚动轨迹具有多套固定模板

代码证据：

- `src/xhs/utils/index.ts:84-150`：搜索滚动始终使用同一 easeInOutQuad、5–11 步、20–80ms 步间隔、固定概率回滚/鼠标移动。
- `src/xhs/clients/services/explore.ts:455-462`：探索滚动把 300–700px 均分为 5–9 个等距离 wheel 事件。
- `src/xhs/clients/services/creator.ts:26-35,121-131,176-195`：创作者页每次固定滚动 500px，固定等待 1000ms+500ms。
- `src/xhs/clients/services/interact.ts:363-366,402-432`：查找评论固定最多 50 次、每 800ms 滚动 0.8 个 viewport。

检测特征（推断）：

- 加速度/jerk 曲线模板高度集中。
- wheel 距离、步数、停顿范围呈清晰截断。
- 创作者页出现精确 500px/1s 周期。
- 搜索、探索、评论查找三个行为簇可被稳定聚类。

置信度：高。

整改：批量读取尽量使用官方接口；UI 滚动仅限人工可见操作。蓝军回放中应采集真实用户基线后比较轨迹分布，而非只检查是否加入 `Math.random()`。

### P1-5 输入和发布过程呈机器输入特征

代码证据：

- `src/xhs/clients/services/publish.ts:140-161`：标题用 `fill()` 瞬时填充；正文 `keyboard.type()` 未提供 delay。
- `src/xhs/clients/services/publish.ts:170-187`：每个标签固定等待 500ms、300ms、300ms。
- `src/xhs/clients/services/publish.ts:440-466`：视频发布同样瞬时标题/正文和固定标签节奏。
- `src/xhs/clients/services/interact.ts:220-231`：评论逐字输入未设置 delay，输入完固定 300ms 后提交。

检测特征（推断）：

- 标题一次性出现；长正文字符间隔接近零。
- 每个标签的选择/空格确认节奏高度一致。
- 输入速度与文本长度、语言、标点无关系，缺少删除和修订。

置信度：高。

整改：发布改成人工复核后提交；在自动生成稿件和平台提交之间设置明确的人审边界。不要依靠简单随机按键延迟作为合规手段。

### P1-6 工具调用总是“新页直达深链—固定等待—执行—关闭”

代码证据：

- `src/xhs/clients/services/interact.ts:29-49,97-99`：点赞直接打开 note URL，2 秒后操作，随后关闭。
- `src/xhs/clients/services/interact.ts:190-205,224-256`：评论同样直达并在结果后关闭。
- `src/xhs/clients/services/content.ts:26-49,140-142`：获取笔记直达页面，仅读 `__INITIAL_STATE__` 后关闭。
- `src/xhs/clients/services/search.ts:41-61,166-168`：每次搜索新建页面并关闭。
- `src/xhs/clients/services/explore.ts:440-445`：默认操作结束关闭页面。
- `src/core/config.ts:83-84`：默认 `keepOpen=false`。

检测特征（推断）：

- 大量无 referrer 的深链导航。
- 页面生命周期与单个动作一一对应。
- 进入内容页后无正常浏览便迅速点赞/评论，再固定时长关闭。
- 浏览历史和前后页面路径不符合自然会话。

置信度：高。

整改：副作用流程改官方接口或人工操作；只读抓取和账号互动必须分离身份与权限。蓝军重点统计 direct-deeplink 比例、页面寿命和每页动作数。

### P1-7 重试会对同一失败页面做机械重复访问

代码证据：

- `src/xhs/utils/index.ts:297-323`：同一 URL 默认重试 3 次。
- `src/xhs/utils/index.ts:303-307`：每次完全相同 goto/networkidle/500ms 检查。
- `src/xhs/utils/index.ts:320-322`：失败后仅用 3–5 秒均匀随机间隔。
- 点赞、收藏、评论、回复、评论点赞均复用该导航函数。

检测特征（推断）：挑战页、404、风控页被以相同页面序列和窄时间窗重复命中，缺少退避和异常分类。

置信度：高。

整改：403/429/验证码/账号异常立即熔断，禁止自动重试写操作；只对明确可恢复的网络错误采用有上限的退避。

### P1-8 AI 评论有固定降级文本与跨账号语义同质化

代码证据：

- `src/core/explore-ai.ts:197-201`：生成失败或解析失败统一评论“很棒的分享！”。
- `src/core/prompts/defaults.ts:9-10`：所有未配置账号使用相同通用人设。
- `src/core/prompts/defaults.ts:65-68`：评论统一限定 10–30 字。
- `src/core/prompts/defaults.ts:99-103`：点赞目标显式规定 70/20/10 分布。
- `src/core/explore-ai.ts:260-264`：点赞决策失败时始终默认点赞帖子。

检测特征（推断）：

- AI 故障时多个账号重复同一短语。
- 评论长度、句法、语义和情绪分布跨账号高度相似。
- AI 服务异常会使点赞率突然升高，而不是停止操作。

置信度：高。

整改：AI 失败必须 fail closed，禁止发布兜底评论或默认点赞；增加评论重复/近似度检查；所有生成评论须人工审核。

## P2

### P2-1 账号锁只解决同账号并发，不提供行为节奏控制

代码证据：

- `src/core/account-lock.ts:31-35`：账号级 FIFO 锁。
- `src/core/account-lock.ts:144-155`：释放后立即唤醒下一个等待者。
- `src/core/account-lock.ts:181-194`：固定 30 秒默认超时。
- `src/core/multi-account.ts:147-150`：操作结束立即释放，无冷却。
- Explore 可运行到 600 秒：`src/tools/explore.ts:106`。

推断：同账号队列可能形成无间隔连续操作；长 explore 会使其他操作固定在 30 秒超时，调用方重试后又出现节奏尖峰。

置信度：中高。

整改：锁和限流分离；队列加入总长度限制、熔断、任务合并与副作用预算，长会话期间拒绝而非鼓励上层重试。

### P2-2 跨会话去重只标记“发生互动”的笔记

代码证据：

- `src/xhs/clients/services/explore.ts:274-280`：候选依赖 `filterUnexploredNotes`。
- `src/xhs/clients/services/explore.ts:366,382,402`：只有点赞或评论后才 `markNoteExplored`。
- 单纯打开、阅读或快速关闭不会跨会话去重。

检测特征（推断）：多次 60 秒会话可能反复打开同一批未互动笔记，形成重复的打开/关闭轨迹，与工具描述“won't see the same note twice”不符。

置信度：高。

整改：把 viewed/opened/interacted 分开记录并设置合理冷却；短期内已看过的笔记不应在下一会话立即重复出现。

### P2-3 发布调度和结果确认不完整，可能造成意外立即发布或重复发布

代码证据：

- `src/xhs/clients/services/publish.ts:191-199`：图文仅点击“定时发布”，没有填写时间，随后仍点击发布。
- `src/xhs/clients/services/publish.ts:470-479`：视频点击发布后固定等待 3 秒便无条件返回成功。
- `src/tools/publish.ts:112-123`：上层据此记录已发布/已调度状态。

推断：夜间或批量任务预期定时但实际立即发布；错误成功状态可能诱发后续补发或重复内容。

置信度：高。

整改：未完整设置并读取确认的 scheduleTime 必须拒绝执行；视频发布复用严格 outcome 验证和幂等键；所有不确定结果进入人工核验，不自动重试。

### P2-4 成功判断多依赖固定 sleep，缺少服务端最终状态核验

代码证据：

- `src/xhs/clients/services/explore.ts:615-617,658-661`：点赞后 500ms 直接返回 true。
- `src/xhs/clients/services/explore.ts:704-706`：评论后 2 秒直接返回 true。
- `src/xhs/clients/services/interact.ts:69-89,149-169`：点赞/收藏后不重新读取最终服务端状态。

推断：平台静默拒绝或挑战时，本地仍继续下一动作，产生“客户端认为成功、服务端无状态”的异常序列。

置信度：中高。

整改：写操作必须有可验证的最终状态；出现挑战、状态不一致或结果不确定时中止整个会话。

## 已有缓解

- 使用 Patchright，且设置 `--disable-blink-features=AutomationControlled`：`src/xhs/clients/constants.ts:9-24`。
- 默认有界随机搜索滚动和少量鼠标移动：`src/xhs/utils/index.ts:84-150`。
- 默认浏览器可见模式：`src/core/config.ts:78-84`。
- 有账号级互斥锁：`src/core/account-lock.ts:48-195`。
- 点赞/收藏前读取现有状态，避免重复点击：`src/xhs/clients/services/interact.ts:51-88,132-169`。
- Explore 有会话内 opened/seen 集合和部分跨会话去重：`src/xhs/clients/services/explore.ts:165-168,274-284`。
- 部分评论/回复会等待输入框清空确认：`src/xhs/clients/services/interact.ts:233-248,332-346`。

这些缓解主要解决稳定性或最基础的重复操作，无法消除非可信 DOM 事件、共享 profile、多账号同步、固定时序和无行为预算等核心风险。

## 盲区

- 本次是静态代码审查，未运行真实账号，也未采集平台前端遥测、网络 HAR、验证码和封禁响应。
- 未审计 Patchright 内部实现，因此 Locator.click/keyboard 产生的底层指纹需动态验证；显式 `dispatchEvent` 的非可信属性不受此盲区影响。
- 未获得真实人工用户基线，无法量化各特征的阈值和误报率。
- 未检查平台移动端、创作者端和 Web 端是否使用不同风控模型。
- 代理出口、TLS/HTTP2 指纹、IP ASN、设备字体/Canvas/WebGL 等不在本行为专项范围内。
- AI 文本识别只能从固定 prompt 与 fallback 推断，尚未做跨账号语料聚类。

## 建议测试指标

建议在隔离测试账号和合规环境中记录：

- `isTrusted=false` 的 click/input 比例；缺失 pointerdown/up、keydown/up、composition 的比例。
- 字符输入速率、字符间隔 CV、零间隔比例、删除/修订率。
- 事件间隔在 300/500/800/1000/2000/3000ms 附近的质量占比。
- wheel 距离、速度、加速度、jerk、步数、回滚率及轨迹聚类纯度。
- 阅读时长与正文长度、图片数、评论数、视频时长的相关系数。
- direct-deeplink 占比、referrer 空值率、页面寿命、单页动作数。
- 每账号每小时/每日写操作数、连续活跃时长、夜间活跃占比。
- 多账号在 1/5/60 秒窗口内命中同 target 的共现率。
- 相同评论、标题、正文、媒体哈希的跨账号复用率。
- 同一 xsecToken 跨账号/跨设备使用次数。
- accountId 与页面实际 userId 不一致次数。
- 同一 browser profile、Cookie、IP、代理、设备指纹关联的账号数。
- 重试 URL 相似度、重试间隔分布、403/429/验证码后的继续操作率。
- fallback 评论“很棒的分享！”出现率、评论长度分布、跨账号语义相似度。
- 客户端成功但服务端状态未变化的比例。
- 定时发布实际时间偏差、重复发布率、sideEffectPossible 结果比例。
