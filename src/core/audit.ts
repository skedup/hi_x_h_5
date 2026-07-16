/**
 * @fileoverview C3.3（P2-2）本地 HTTP MCP 鉴权与读写能力分级——纯逻辑层。
 *
 * 与 HTTP 传输解耦，便于离线单元测试覆盖 bearer 鉴权 / 只读 scope / 批量确认。
 * 接入点：src/http-server.ts 的 /mcp 端点。
 * @module core/audit
 */

/**
 * 写工具集合（P2-2 读写能力分级）。
 * 这些工具会产生平台侧副作用 / 账号配置变更 / 本地文件写入，持只读 bearer token 时一律拒绝。
 * 与各 tools 模块的工具定义保持同步；新增写工具须在此登记，否则默认按读处理（更宽松）。
 */
export const WRITE_TOOL_NAMES = new Set<string>([
  // 互动（点赞/收藏/评论/回复/删 cookie）
  'xhs_like_feed',
  'xhs_favorite_feed',
  'xhs_post_comment',
  'xhs_reply_comment',
  'xhs_like_comment',
  'xhs_delete_cookies',
  // 发布
  'xhs_publish_video',
  // 草稿（创建/更新/删除/发布）
  'xhs_create_draft',
  'xhs_update_draft',
  'xhs_delete_draft',
  'xhs_publish_draft',
  // 账号配置变更
  'xhs_add_account',
  'xhs_submit_verification',
  'xhs_remove_account',
  'xhs_set_account_config',
  'xhs_set_account_prompt',
  // 下载（本地文件写入 + 外网拉取）
  'xhs_download_images',
  'xhs_download_video',
  // 自动浏览（驱动页面、可能评论）
  'xhs_explore',
]);

export interface AuthorizationInput {
  /** 请求携带的 bearer token（已剥离 "Bearer " 前缀，可能为空） */
  presentedToken: string;
  /** tools/call 的工具名；非 tools/call 时为 undefined */
  tool?: string;
  /** tools/call 的参数（用于判断多账号批量） */
  args?: Record<string, any>;
  /** 配置的全量 bearer token（空表示不启用鉴权） */
  bearerToken: string;
  /** 配置的只读 bearer token */
  bearerTokenReadonly: string;
  /** 配置的批量写确认值（空表示不强制确认） */
  bulkConfirmToken: string;
  /** 请求头 X-Xhs-Write-Confirm 的值 */
  confirmHeader: string;
}

export interface AuthDecision {
  ok: boolean;
  httpStatus?: number;
  code?: number;
  message?: string;
}

/**
 * 评估一次 MCP 请求是否被允许（纯函数）。
 * 不依赖 Hono Context，便于单测。
 */
export function evaluateAuthorization(input: AuthorizationInput): AuthDecision {
  const { presentedToken, tool, args, bearerToken, bearerTokenReadonly, bulkConfirmToken, confirmHeader } = input;

  // 1) Bearer 鉴权：配置了全量 token 后，/mcp 必须携带正确 token。
  //    全量 token 与只读 token（若配置）均为合法凭证；二者都不是才 401。
  if (bearerToken) {
    const tokenValid =
      presentedToken === bearerToken ||
      (!!bearerTokenReadonly && presentedToken === bearerTokenReadonly);
    if (!presentedToken || !tokenValid) {
      return { ok: false, httpStatus: 401, code: -32001, message: 'Unauthorized: missing or invalid bearer token' };
    }
  }

  // 2) 只读 scope 分级：持 readonly token（且不同于全量 token）时拒绝任何写工具
  const readonlyScope = !!(
    bearerTokenReadonly &&
    bearerToken &&
    presentedToken === bearerTokenReadonly &&
    bearerTokenReadonly !== bearerToken
  );

  if (tool && readonlyScope && WRITE_TOOL_NAMES.has(tool)) {
    return { ok: false, httpStatus: 403, code: -32000, message: `Forbidden: read-only token cannot invoke write tool "${tool}"` };
  }

  // 3) 批量写确认：多账号写（accounts='all' 或数组长度>1）需 X-Xhs-Write-Confirm 头
  if (tool && WRITE_TOOL_NAMES.has(tool) && bulkConfirmToken) {
    const accounts = args?.accounts;
    const isBulk = accounts === 'all' || (Array.isArray(accounts) && accounts.length > 1);
    if (isBulk && confirmHeader !== bulkConfirmToken) {
      return {
        ok: false,
        httpStatus: 403,
        code: -32000,
        message: 'Forbidden: bulk write requires X-Xhs-Write-Confirm header matching XHS_MCP_BULK_CONFIRM',
      };
    }
  }

  return { ok: true };
}
