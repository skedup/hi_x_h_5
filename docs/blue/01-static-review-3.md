蓝军审查员 3 静态审查结论：当前版本不宜开启多账号自动发布/互动。最大风险不是“随机性不够”，而是账号隔离失效、批量同内容/同目标、页面可直接观测的非可信事件，以及缺少中央风控策略。

以下“平台可见”指平台网页或服务端可观测；SQLite、Prompt 文件和本地日志本身不会直接暴露给平台。

## P0

### P0-1 多账号实际共享一个 Chrome Profile，账户 state 没有恢复

- 证据：
  - [src/core/config.ts:169](/Users/skedushwang/projects/hi_x_h_5/src/core/config.ts:169)：全局唯一 `browser-profile` 路径。
  - [src/xhs/clients/context.ts:24](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/context.ts:24)：所有客户端都用该路径启动 persistent context。
  - [src/xhs/clients/context.ts:90](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/context.ts:90)：初始化只传 proxy，没有应用 `options.state`。
  - [src/core/account-pool.ts:70](/Users/skedushwang/projects/hi_x_h_5/src/core/account-pool.ts:70)：DB 中的 account state 虽传入客户端，但上述启动流程未消费它。
  - [src/xhs/clients/context.ts:37](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/context.ts:37)：`webId` 也属于共享 profile。
- 平台可见特征：多个逻辑账号共享 cookies、localStorage、webId、Chrome profile 和设备指纹；切换 proxy 时可能出现同 profile 跨出口，甚至逻辑账号 A 的操作实际由账号 B 发出。
- 事实/推断：共享路径和 state 未加载是事实；账号串号、设备图谱强关联是高概率推断。
- 置信度：高。
- 整改：每账号独立 user-data-dir，或独立非持久 context 并显式加载 storageState；副作用前强校验当前页面 `userId === DB profile.userId`；禁止同一 profile 并发启动；profile、proxy、账号建立不可拆绑定。
- 动态验证：给 A/B storageState 写入不同 canary cookie，分别启动并读取 cookies、webId、登录 userId；任何交叉即阻断发布。

### P0-2 支持对多账号发布完全相同内容，并默认并行执行互动/发布

- 证据：
  - [src/tools/draft.ts:197](/Users/skedushwang/projects/hi_x_h_5/src/tools/draft.ts:197)：工具明确宣称“multiple accounts with identical content”。
  - [src/tools/draft.ts:558](/Users/skedushwang/projects/hi_x_h_5/src/tools/draft.ts:558)：所有账号复用同一 title/content/images/tags。
  - [src/core/multi-account.ts:233](/Users/skedushwang/projects/hi_x_h_5/src/core/multi-account.ts:233)：未指定 sequential 时 `Promise.all` 并行。
  - [src/tools/interaction.ts:306](/Users/skedushwang/projects/hi_x_h_5/src/tools/interaction.ts:306)：同一 note、同一 comment content 可对 `accounts/all` 并发评论。
  - [src/tools/publish.ts:97](/Users/skedushwang/projects/hi_x_h_5/src/tools/publish.ts:97)：视频虽串行，但各账号仍复用同一文件和文案。
- 平台可见特征：完全相同的文本、图片/视频文件哈希、标签、目标笔记以及秒级相近时间戳；同设备/出口会进一步增强关联。
- 事实/推断：同参数复用和并行是事实；被识别为协同自动化或账号矩阵是高置信推断。
- 置信度：高。
- 整改：默认禁止一份 draft 发布到多个账号；跨账号相同媒体 pHash、正文 hash、近似文本必须 fail closed；所有写操作默认单账号且需人工确认；不要以改写/扰动内容规避检测，应明确业务授权与内容归属。

### P0-3 自动浏览使用页面可直接识别的非可信 DOM 事件

- 证据：
  - [src/xhs/clients/services/explore.ts:529](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:529)：`HTMLElement.click()` 在页面 JS 中触发打开。
  - [src/xhs/clients/services/explore.ts:683](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:683)：一次性设置 `textContent`，随后手工 `dispatchEvent(new Event('input'))`。
  - [src/xhs/clients/services/interact.ts:315](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/interact.ts:315)：回复评论采用同类直接赋值。
  - [src/xhs/clients/services/interact.ts:529](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/interact.ts:529)：手工构造 `MouseEvent` 点赞评论。
- 平台可见特征：事件 `isTrusted=false`、缺少 pointer/key/beforeinput 事件链、整段文本在单个 input 事件内出现。
- 事实/推断：合成事件是事实；页面侧可监听这些字段也是事实。
- 置信度：高。
- 整改：不要增加伪造事件来掩盖自动化。
- 动态验证：测试页捕获 click/pointerdown/keydown/beforeinput/input 的 `isTrusted`、顺序和时间戳，回放当前流程即可确认。

### P0-4 无中央限额、冷却、跨账号去重或风险熔断

- 证据：
  - [src/core/config.ts:78](/Users/skedushwang/projects/hi_x_h_5/src/core/config.ts:78)：仅有固定 2 秒 request interval。
  - [src/core/multi-account.ts:160](/Users/skedushwang/projects/hi_x_h_5/src/core/multi-account.ts:160)：多账号默认并行。
  - [src/xhs/clients/services/explore.ts:274](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:274)：去重仅在单账号范围。
  - [src/xhs/clients/services/explore.ts:366](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:366)：且只有成功互动后才记为 explored。
- 平台可见特征：跨账号同时操作同一目标、固定最小间隔、高峰突发、每日累计无上限。
- 置信度：高。
- 整改：统一写操作 policy engine；按账号、出口、动作、目标配置小时/日预算、冷却和并发上限；跨账号 target/content/media 去重；出现验证码、封禁、429、连续失败时立即取消队列并进入人工审查。

## P1

### P1-1 AI 异常时 fail-open，固定评论和默认点赞会形成强特征

- 证据：
  - [src/core/explore-ai.ts:192](/Users/skedushwang/projects/hi_x_h_5/src/core/explore-ai.ts:192)：解析失败或 API 异常均返回固定“很棒的分享！”。
  - [src/core/explore-ai.ts:260](/Users/skedushwang/projects/hi_x_h_5/src/core/explore-ai.ts:260)：点赞决策失败默认点赞帖子。
  - [src/xhs/clients/services/explore.ts:390](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:390)：生成结果未经二次校验直接提交。
- 平台可见特征：AI 故障期间跨主题、跨账号集中出现完全相同评论；决策故障反而增加点赞。
- 置信度：高。
- 整改：任何 AI 调用/解析失败均不得产生写操作；固定 fallback 只用于展示，不得发布。

### P1-2 Prompt 和输出没有抗注入、内容安全或重复性校验

- 证据：
  - [src/core/explore-ai.ts:172](/Users/skedushwang/projects/hi_x_h_5/src/core/explore-ai.ts:172)：不可信笔记标题/正文直接进入 Prompt。
  - [src/core/explore-ai.ts:192](/Users/skedushwang/projects/hi_x_h_5/src/core/explore-ai.ts:192)：仅检查存在 `comment` 字段，无长度、URL、敏感词、重复度、策略校验。
  - [src/tools/account.ts:770](/Users/skedushwang/projects/hi_x_h_5/src/tools/account.ts:770)：账号 Prompt 可写入任意非空内容，无版本审批。
- 平台可见特征：恶意笔记可诱导评论带链接、营销话术或违规内容；账号输出风格漂移。
- 置信度：高。
- 整改：模型输出视为不可信；增加结构、长度、字符、URL/联系方式、敏感内容、历史相似度校验；评论必须人工预览确认；Prompt 需版本化、审批、回滚。

### P1-3 默认 Persona、评论长度和行为概率在所有账号间高度同质

- 证据：
  - [src/core/prompts/defaults.ts:9](/Users/skedushwang/projects/hi_x_h_5/src/core/prompts/defaults.ts:9)：所有账号初始 Persona 相同。
  - [src/core/prompt-manager.ts:74](/Users/skedushwang/projects/hi_x_h_5/src/core/prompt-manager.ts:74)：账号目录自动写入同一套默认模板。
  - [src/core/prompts/defaults.ts:65](/Users/skedushwang/projects/hi_x_h_5/src/core/prompts/defaults.ts:65)：评论统一约束为 10–30 字。
  - [src/core/prompts/defaults.ts:99](/Users/skedushwang/projects/hi_x_h_5/src/core/prompts/defaults.ts:99)：点赞目标固定 70/20/10。
  - [src/xhs/clients/services/explore.ts:127](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:127)：open/like/comment 默认概率统一为 0.5/0.5/0.1。
- 平台可见特征：跨账号相似的句长、语气、点赞比例和会话行为分布。
- 事实/推断：统一模板与概率是事实；统计聚类识别为高概率推断。
- 置信度：中高。
- 整改：默认关闭自动评论；账号 Persona 应由真实运营者编写并人工确认。重点是建立合规、人审和停止机制，不是调随机数来规避检测。

### P1-4 所谓“真人行为”仍是与内容无关的固定概率模型

- 证据：
  - [src/xhs/clients/services/explore.ts:196](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:196)：10% 快滑、5% 回滚。
  - [src/xhs/clients/services/explore.ts:224](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:224)：阅读固定为 3–8 秒或 10–20 秒，与正文长度/图片数无关。
  - [src/xhs/clients/services/explore.ts:326](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/explore.ts:326)：15% 快关，modal 阅读同样使用固定区间。
- 平台可见特征：大样本下各账号出现同构停留时长分布和动作转移矩阵。
- 置信度：中高。
- 整改：不要继续增强“仿人”；将 explore 降级为只读推荐或人工辅助，写操作独立审批。

### P1-5 AI 图片存在可检测的生成来源和模板化视觉痕迹

- 证据：
  - [src/core/config.ts:105](/Users/skedushwang/projects/hi_x_h_5/src/core/config.ts:105)：固定 Gemini 图片模型。
  - [src/core/gemini.ts:414](/Users/skedushwang/projects/hi_x_h_5/src/core/gemini.ts:414)：生成结果原始字节直接落盘，不检查 provenance/元数据。
  - [src/core/image-processor/graph/nodes/beautify.ts:164](/Users/skedushwang/projects/hi_x_h_5/src/core/image-processor/graph/nodes/beautify.ts:164)：所有美化图再次由 Gemini 生成。
  - [src/core/image-processor/graph/nodes/beautify.ts:197](/Users/skedushwang/projects/hi_x_h_5/src/core/image-processor/graph/nodes/beautify.ts:197)：虽经 Sharp 重编码为 PNG，但这不能证明像素级水印/生成取证信号被移除。
  - [src/core/image-processor/prompts/phase2-layout.txt:146](/Users/skedushwang/projects/hi_x_h_5/src/core/image-processor/prompts/phase2-layout.txt:146) 与 [src/core/image-processor/prompts/phase4-beautify.txt:180](/Users/skedushwang/projects/hi_x_h_5/src/core/image-processor/prompts/phase4-beautify.txt:180)：全量手写体、手绘插画、固定 slide 模式。
- 平台可见特征：生成模型水印/取证特征、统一画布、调色板、手写体、封面—步骤—总结结构和跨账号媒体 pHash 近似。
- 事实/推断：AI 生成和固定模板是事实；具体水印是否存在需动态验证。
- 置信度：中高。
- 整改：保留并申报 AI provenance，不要以移除元数据为目标；发布前人工内容与版权审核；默认禁止同一生成图跨账号复用。
- 动态验证：对样本执行 `exiftool`、C2PA 验证、授权的 SynthID 检测、OCR/字体统计、pHash/SSIM 聚类。

### P1-6 已识别封禁状态，但不会自动停用账号

- 证据：
  - [src/tools/auth.ts:123](/Users/skedushwang/projects/hi_x_h_5/src/tools/auth.ts:123)：`isBanned` 仅写入 profile。
  - [src/core/multi-account.ts:77](/Users/skedushwang/projects/hi_x_h_5/src/core/multi-account.ts:77)：显式指定账号执行时不检查 `account.status` 或 profile ban 状态。
  - [src/core/account-pool.ts:58](/Users/skedushwang/projects/hi_x_h_5/src/core/account-pool.ts:58)：`getClient` 同样不拒绝 suspended/banned。
- 平台可见特征：封禁或风险提示后继续重试写操作。
- 置信度：高。
- 整改：同步到 ban/risk 状态时原子暂停账号、销毁客户端、取消排队写操作；恢复必须人工审批。

### P1-7 定时发布参数并未真正设置，可能导致计划内容立即发出

- 证据：
  - [src/xhs/clients/services/publish.ts:191](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/publish.ts:191)：图片发布只点击“定时发布”，随后明确记录“not fully implemented”，仍继续点击发布。
  - [src/xhs/clients/services/publish.ts:392](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/services/publish.ts:392)：视频流程完全未使用 `scheduleTime`。
- 平台可见特征：本应错峰的多账号内容集中即时发布。
- 置信度：高。
- 整改：功能完成前拒绝含 `scheduleTime` 的请求；发布前读取 UI 回显并校验时间，不一致不得点击发布。

## P2

### P2-1 审计数据过度删减，无法支撑重复检测和事故调查

- [src/db/repos/operations.ts:60](/Users/skedushwang/projects/hi_x_h_5/src/db/repos/operations.ts:60)：传入 target/params/result/error，但实际全部写 NULL。
- [src/db/repos/interactions.ts:27](/Users/skedushwang/projects/hi_x_h_5/src/db/repos/interactions.ts:27)：评论正文和错误同样被丢弃。
- 这是良好的隐私保护方向，但当前没有保留不可逆 target/content hash、risk code、策略决策、AI/human 来源，导致无法做跨账号重复检测、限额和追责。
- 整改：保留加盐哈希、动作类别、策略版本、模型版本、人审人/时间、风险码和最小化错误分类；正文仍不落盘。

### P2-2 本地 HTTP MCP 没有鉴权或写能力分级

- [src/http-server.ts:50](/Users/skedushwang/projects/hi_x_h_5/src/http-server.ts:50)：拒绝带 Origin 的浏览器请求。
- [src/http-server.ts:211](/Users/skedushwang/projects/hi_x_h_5/src/http-server.ts:211)：仅绑定 `127.0.0.1`，是已有保护。
- [src/server.ts:45](/Users/skedushwang/projects/hi_x_h_5/src/server.ts:45)：同一会话暴露所有账号、发布、互动、Prompt 修改工具，无 token 或 capability 分级。
- 风险：任意本机进程或 SSRF 链路可触发批量副作用，进而制造平台侧异常。
- 整改：本地 bearer token/mTLS 或 Unix socket；读写工具分服务；批量写操作单独 capability 和人工确认。

### P2-3 缺少自动化风险回归测试

- [package.json:15](/Users/skedushwang/projects/hi_x_h_5/package.json:15)：只有 search/note 冒烟脚本，无账号隔离、事件可信度、限额、重复内容、AI 失败、封禁熔断、scheduleTime 测试。
- 整改：新增无真实副作用的 mock/fixture 测试，并把上述项目列为发布门禁。

## 已有保护

- `patchright`、真实 Chrome channel、默认有头模式和 `AutomationControlled` 参数：[src/xhs/clients/context.ts:7](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/context.ts:7)、[src/xhs/clients/constants.ts:9](/Users/skedushwang/projects/hi_x_h_5/src/xhs/clients/constants.ts:9)。
- 搜索存在缓动滚动、随机延迟、回滚和鼠标移动：[src/xhs/utils/index.ts:84](/Users/skedushwang/projects/hi_x_h_5/src/xhs/utils/index.ts:84)。
- 单账号 FIFO 锁可防同账号并发。
- explore 有会话内及单账号跨会话去重。
- 普通评论与发布正文部分路径使用 `keyboard.type`，优于直接修改 DOM。
- DB 使用 `umask 077`、文件 0600、secure delete，并主动 scrub 敏感 payload：[src/db/index.ts:70](/Users/skedushwang/projects/hi_x_h_5/src/db/index.ts:70)。
- HTTP 绑定 loopback 并拒绝浏览器 Origin。
- 图片流程存在 AI 质量检查，但目前只检查文字、美观、顺序，不检查 provenance、重复度和内容政策。

## 建议动态验证顺序

1. 立即停用多账号写操作，先执行 A/B cookie、webId、userId 隔离 canary。
2. 在本地测试页记录 `isTrusted` 与事件链，确认 explore/reply/like-comment 的合成事件。
3. API 500、超时、畸形 JSON 故障注入，验证评论和点赞必须 fail closed。
4. Shadow mode 运行 7–14 天，只记录拟执行动作，不实际点赞/评论/发布；统计跨账号 5 秒内同目标率、间隔分布、评论 n-gram/embedding 相似度和媒体 pHash。
5. 对封禁/429/验证码事件做队列取消测试。
6. 对 scheduleTime 做 UI 回显断言。
7. 对生成图做 provenance、元数据、OCR 风格和 pHash 检测。

本轮只读审查，未修改文件。
