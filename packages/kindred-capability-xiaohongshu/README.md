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

Kindred 配置示例：

```yaml
capabilities:
  xiaohongshu:
    enabled: true
    side_effect_activities: [play_xiaohongshu]
    settings:
      mcp_url: http://127.0.0.1:18060
      timeout: 15
      write_mode: none
```

`settings` 严格支持：

- `mcp_url`：必填，只接受 loopback HTTP 服务根地址；
- `timeout`：可选，默认 15 秒；
- `write_mode`：`none | dry_run | live`，默认 `none`。

namespaced secret：

- `readonly_bearer_token`：优先用于 initialize 和只读工具；
- `bearer_token`：用于写工具；只配置它时也可承担只读调用。

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

`write_mode=none` 时不贡献写 ToolBinding；`dry_run` 会完整校验引用和 Artifact，但不会调用任何上游
写工具；`live` 才调用 Node 服务。EXT2 只用 fake service 验证 `live`，不执行真实写操作。

模型只看到 `feed_ref`、`user_ref`、`comment_ref`。真实平台 ID 与 `xsecToken` 仅存于
capability-scoped `TransientStore`，随工具环结束失效；伪造、跨 tick、过期引用和父帖子不匹配
都会在 MCP 调用前拒绝。

## Compose Artifact

发布、评论和回复只接受 `artifact_ref`，消费 profile：

```text
kindred.compose.xiaohongshu.v1
```

package 同时要求 `artifact.explicit_refs.v1`，只接受当前 Activity run 中已经由 T3 持久化的 ref。
目录约定：

```text
artifact.json          # Host 生成，package 不写
title.txt               # publish 必需
content.md              # publish/comment/reply 必需
assets/index.json       # publish 图片索引，可选
assets/<image>          # 直接普通文件
```

`assets/index.json`：

```json
{"files":["assets/01.png","assets/02.jpg"]}
```

索引最多 9 项，只接受 `assets/` 直接子文件和 `.png/.jpg/.jpeg/.webp`。ArtifactReader 当前不提供
目录枚举，因此无索引即视为没有图片。现有 Node 发布链要求至少一张图片；没有图片的 Artifact
可以用于评论/回复，但发布会返回结构化 `InvalidArtifact`。

发布时 package 在单次 invocation 的临时目录恢复图片，连续调用
`xhs_create_draft -> xhs_publish_draft`，随后删除临时目录。临时绝对路径不会进入模型结果、
Kindred trace 或日志。

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
- Python package：1085 行非空生产代码
- Node handshake：12 行非空生产改动

本机只读 handshake 使用现有测试账号和持久化 profile，依次验证了 health、initialize、
tools/list、list、search 和 detail。结果为：

- 上游工具 35 个，Portable `write_mode=none` 工具 6 个；
- list/search 各返回 5 条紧凑投影；
- list 约 17.9 秒，detail 约 6.5 秒，search 约 5.2 秒；
- 三次业务响应大小约为 1.3 KiB、1.1 KiB、1.3 KiB；
- 未执行任何平台写操作，完成后恢复原 launchd 服务。

门禁结果：

- Python package：38 passed，strict mypy、ruff、wheel build、clean venv entry point
  discovery 通过；
- Node source：89 passed；native migration regression：3 passed；
- ESLint 无 error，TypeScript build 通过。

结论：**EXT2 GO**。Portable package 已能独立承担 XHS 工具契约、短期引用、Artifact 消费、
MCP transport 和安全投影；Kindred 尚未安装或切流，需等待 EXT3。
