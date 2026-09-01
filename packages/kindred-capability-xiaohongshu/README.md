# kindred-capability-xiaohongshu

`hi_x_h_5` 官方维护的 Kindred Portable Capability。Python package 只负责 Kindred 工具契约、
短期引用、预算、安全投影和 Artifact 消费；浏览器、登录、账号风险与平台协议继续唯一归属本仓
Node 服务。

```text
Kindred Host
  -> kindred-capability-xiaohongshu
  -> loopback Streamable HTTP /mcp
  -> hi_x_h_5 / Patchright / Chrome
```

## 安装与配置

package 依赖 `kindred-capability-sdk>=0.1.0,<0.2`，entry point 为：

```text
group: kindred.capability.v1
name:  xiaohongshu
value: kindred_capability_xiaohongshu.plugin:create_capability
```

同一个 wheel 还通过 `kindred.resources.v1` 的 `xiaohongshu` entry point 自带两项 Action、
一项 Activity 与 XHS Compose profile route。Kindred Host 在装配时与公共生活资产组成 15/8
只读视图；本 package 不再依赖 Kindred root patch 或 derived wheel。

`0.3.0` 建立首个公开资源闭包，`0.3.1` 收紧正式发行包的校验文件与构建元数据边界。
`0.3.2` 补齐 wheel 许可证正文及公开发行的 clean-install 验证；Portable 工具契约不变。
wheel 与双平台 immutable sidecar 均从本仓同一正式 tag 构建；sidecar 的安装、状态和交互式
登录入口见[正式发行文档](../../docs/kindred-release.md)。

Kindred 配置示例：

```yaml
capabilities:
  xiaohongshu:
    enabled: true
    side_effect_activities: [play_xiaohongshu]
    settings:
      mcp_url: http://127.0.0.1:18060
      timeout: 45
      write_mode: none
```

`settings` 严格支持：

- `mcp_url`：必填，只接受 loopback HTTP 服务根地址；
- `timeout`：可选，默认 45 秒；
- `write_mode`：`none | dry_run | live`，默认 `none`。

namespaced secret：

- `readonly_bearer_token`：优先用于 initialize 和只读工具；
- `bearer_token`：用于写工具；只配置它时也可承担只读调用。

Node 服务仍沿用既有鉴权语义：服务端的全量 bearer 是鉴权总开关，readonly bearer 只是附加的
只读凭据。只读部署也应在 Node 端配置全量 bearer，并在接入侧仅持有 readonly bearer；本 package
不改变服务原有鉴权策略。

package 不枚举其他 capability 的 secret，也不在异常或 ToolResult 中回显 secret。

## 工具边界

只读工具：

- `xiaohongshu_list_feeds`
- `xiaohongshu_search`
- `xiaohongshu_feed_detail`
- `xiaohongshu_user_profile`
- `xiaohongshu_my_posts`
- `xiaohongshu_notifications`

写工具：

- `xiaohongshu_publish_post`
- `xiaohongshu_comment_post`
- `xiaohongshu_reply_comment`
- `xiaohongshu_like_post`
- `xiaohongshu_favorite_post`
- `xiaohongshu_like_comment`

`write_mode=none` 时不贡献写 ToolBinding，也不申请 ArtifactReader 或 Artifact profile；
`dry_run/live` 要求 Host 同时启用 Compose 和 Draw contribution。`dry_run` 会完整校验引用和
Artifact，但不会调用任何上游写工具；`live` 才调用 Node 服务。

package 只阻止同一工具环中的直接重复写；跨工具环继续使用 `hi_x_h_5` 原生 best-effort dedup，
不新增 package 私有 ledger 或改变 Node 的去重身份。comment/reply 的 Artifact 正文最多 180 字。

模型只看到 `feed_ref`、`user_ref`、`comment_ref`。真实平台 ID 与 `xsecToken` 仅存于
capability-scoped `TransientStore`，随工具环结束失效；伪造、跨 tick、过期引用和父帖子不匹配
都会在 MCP 调用前拒绝。

## Publish Artifact

`kindred-capability-xiaohongshu==0.2.0` 将发布改为显式消费当前 Activity run 中的文字与图片：

```text
xiaohongshu_publish_post(
  text_artifact_ref,
  image_artifact_refs
)
```

- `text_artifact_ref`：一个 committed `kindred.compose.xiaohongshu.v1`；
- `image_artifact_refs`：按平台展示顺序排列的 1~9 个 committed
  `kindred.draw.image.v1`；
- 两类 ref 都必须由 `artifact.explicit_refs.v1` 证明属于当前 Activity run；
- 图片 ref 不得重复，每个 Draw Artifact 只读取固定 member `image.png`；
- 每张图片上限 8 MiB，必须是结构与 CRC 均有效的 PNG；
- 任一 Artifact 失败时，不创建临时发布目录，也不调用 Node 服务。

文字 Artifact 目录约定：

```text
artifact.json          # Host 生成，package 不写
title.txt               # publish 必需
content.md              # publish/comment/reply 必需
```

图片 Artifact 目录约定：

```text
artifact.json
image.png
```

评论和回复继续只接受 Compose `artifact_ref`，只读取 `content.md`，不读取 Draw Artifact。
旧 publish `artifact_ref`、Compose 内 `assets/index.json` 和内嵌图片不再兼容。

发布时 package 先完整校验全部 Artifact，再按输入顺序将图片恢复为单次 invocation 临时目录中的
`001.png`~`009.png`，连续调用
`xhs_create_draft -> xhs_publish_draft`，随后删除临时目录。临时绝对路径不会进入模型结果、
Kindred trace 或日志。

同一工具环内，文字 ref 与有序图片 refs 共同构成 operation identity。完全相同的调用返回
`already_done`；图片不同或顺序变化视为不同操作。本 package 不新增跨 tick ledger。

`0.2.1` 为发布稳定性修复：`xhs_publish_draft` 使用独立的长操作超时；浏览器在点击发布前
失败时返回明确 Provider failure，只有开始提交后结果无法确认才返回 UnknownSideEffect。
两条路径都不会自动重试。

## Service handshake

Node 服务在 `/health` 返回：

```json
{
  "status": "ok",
  "server": "xhs-mcp",
  "version": "2.0.0",
  "service_api_version": "1"
}
```

`service_api_version` 是 package 与服务之间的稳定接口版本，不随 npm patch version 自动变化。
`0.2.0` 的不兼容变化只发生在 Portable ToolDef 和 Artifact consumer，Node MCP/HTTP 合同未变，
因此 service API 继续为 `1`。
package 首次调用顺序固定为：

1. `GET /health` 并校验 `service_api_version`；
2. MCP `initialize`；
3. 固定白名单内的 `tools/call`。

版本缺失或不匹配时不会进入步骤 2/3。

## 工具映射

| Kindred 工具 | hi_x_h_5 MCP 工具 |
| --- | --- |
| `xiaohongshu_list_feeds` | `xhs_list_feeds` |
| `xiaohongshu_search` | `xhs_search` |
| `xiaohongshu_feed_detail` | `xhs_get_note` |
| `xiaohongshu_user_profile` | `xhs_user_profile` |
| `xiaohongshu_my_posts` | `xhs_get_my_notes` |
| `xiaohongshu_notifications` | `xhs_get_notifications` |
| `xiaohongshu_publish_post` | `xhs_create_draft` -> `xhs_publish_draft` |
| `xiaohongshu_comment_post` | `xhs_post_comment` |
| `xiaohongshu_reply_comment` | `xhs_reply_comment` |
| `xiaohongshu_like_post` | `xhs_like_feed` |
| `xiaohongshu_favorite_post` | `xhs_favorite_feed` |
| `xiaohongshu_like_comment` | `xhs_like_comment` |

上游工具名来自 package 内固定白名单，不接受模型输入。Portable ToolResult 只使用短期 opaque ref
和收敛字段，不透传 MCP ToolDef、JSON-RPC envelope 或平台参数。

## 开发验证

需要使用 Kindred 对应提交构建出的 SDK wheel，不能复制 SDK 源码：

```bash
uv build /path/to/kindred/packages/kindred-capability-sdk
uv build packages/kindred-capability-xiaohongshu
```

测试必须使用 fake MCP transport/fake service。真实环境只允许低频执行 health、initialize、
tools/list 和必要的 list/search/detail；真实写操作必须单独授权。

## EXT2 验证基线

- Kindred SDK commit：`356a77b`
- hi_x_h_5 service 基线：`5607e8f89874759cc04efc76e0d6ea820d03df3b`
- package：`kindred-capability-xiaohongshu==0.1.0`
- service API：`1`
- Python package：1107 行非空生产代码
- Node handshake：12 行非空生产改动

本机只读 handshake 使用现有测试账号和持久化 profile，依次验证了 health、initialize、
tools/list、list、search 和 detail。结果为：

- 上游工具 35 个，Portable `write_mode=none` 工具 6 个；
- list/search 各返回 5 条紧凑投影；
- list 约 17.9 秒，detail 约 6.5 秒，search 约 5.2 秒；
- 三次业务响应大小约为 1.3 KiB、1.1 KiB、1.3 KiB；
- 未执行任何平台写操作，完成后恢复原 launchd 服务。

门禁结果：

- Python package：42 passed，ruff、wheel build、clean venv entry point discovery 通过；strict mypy
  使用固定 SDK source。SDK wheel 的 `py.typed` 打包缺口由 Kindred 在 EXT3 前修复；
- Node source：88 passed；native migration regression：3 passed；
- ESLint 无 error，TypeScript build 通过。

结论：**EXT2 GO**。Portable package 已能独立承担 XHS 工具契约、短期引用、Artifact 消费、
MCP transport 和安全投影；Kindred 尚未安装或切流，需等待 EXT3。
