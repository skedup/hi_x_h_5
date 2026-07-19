/**
 * @fileoverview C3.3（P2-2）本地 HTTP MCP 鉴权与读写能力分级——纯逻辑层。
 *
 * 与 HTTP 传输解耦，便于离线单元测试覆盖 bearer 鉴权 / 只读 scope / 批量确认。
 * 接入点：src/http-server.ts 的 /mcp 端点。
 * @module core/audit
 */

/**
 * 工具能力登记（P1 审计 fail-open 修复 / 蓝军 #11）。
 * 每个注册到 MCP server 的工具都必须在此显式声明能力：
 * - 'read'    无平台副作用的只读工具（含本地只读查询）
 * - 'control' 本机会话控制类（如停止浏览），非平台写，只读 token 亦可使用
 * - 'write'   产生平台侧副作用 / 本地文件写入 / 账号配置变更的工具
 * 未知或未分类工具对只读 token 一律 fail-closed（拒绝）。
 * server.ts 启动时断言 allTools 全部登记，缺失即启动失败。
 */
export type ToolCapability = 'read' | 'write' | 'control';

export const TOOL_CAPABILITIES: Record<string, ToolCapability> = {
  // —— 读（无平台副作用）——
  xhs_check_auth_status: 'read',
  xhs_get_notifications: 'read',
  xhs_search: 'read',
  xhs_get_note: 'read',
  xhs_user_profile: 'read',
  xhs_list_feeds: 'read',
  xhs_get_account_stats: 'read',
  xhs_get_operation_logs: 'read',
  xhs_get_my_notes: 'read',
  xhs_query_my_notes: 'read',
  xhs_list_accounts: 'read',
  xhs_get_account_prompt: 'read',
  xhs_list_drafts: 'read',
  xhs_get_draft: 'read',

  // —— 控制（本机会话控制，非平台写；只读 token 亦可用）——
  xhs_stop_explore: 'control',

  // —— 写（平台副作用 / 本地文件写入 / 账号配置变更）——
  xhs_like_feed: 'write',
  xhs_favorite_feed: 'write',
  xhs_post_comment: 'write',
  xhs_reply_comment: 'write',
  xhs_like_comment: 'write',
  xhs_delete_cookies: 'write',
  xhs_download_images: 'write',
  xhs_download_video: 'write',
  xhs_publish_video: 'write',
  xhs_add_account: 'write',
  xhs_submit_verification: 'write',
  xhs_remove_account: 'write',
  xhs_set_account_config: 'write',
  xhs_set_account_prompt: 'write',
  xhs_explore: 'write',
  xhs_create_draft: 'write',
  xhs_update_draft: 'write',
  xhs_delete_draft: 'write',
  xhs_publish_draft: 'write',
  // 登录态检查可能在登录成功时创建/更新账号、profile 与 operation log（蓝军 P1）
  xhs_check_login_session: 'write',
};

/** 写工具集合（由能力登记表派生，保持与 tools 模块同步）。 */
export const WRITE_TOOL_NAMES = new Set<string>(
  Object.entries(TOOL_CAPABILITIES)
    .filter(([, cap]) => cap === 'write')
    .map(([name]) => name),
);

export function isWriteTool(tool: string): boolean {
  return TOOL_CAPABILITIES[tool] === 'write';
}

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

  // 2) 只读 scope 分级：持 readonly token（且不同于全量 token）时，仅允许 read/control 能力工具。
  //    写工具与“未知/未分类”工具一律 fail-closed（蓝军 P1：避免漏列变更工具被只读 token 直接调用）。
  const readonlyScope = !!(
    bearerTokenReadonly &&
    bearerToken &&
    presentedToken === bearerTokenReadonly &&
    bearerTokenReadonly !== bearerToken
  );

  if (readonlyScope && tool !== undefined) {
    // 仅对真实工具调用（tools/call）做只读分级；MCP 协议方法（initialize/list/ping/
    // notifications/*）本身不带工具名（tool=undefined），不受 readonly scope 约束，
    // 否则 readonly token 连初始化连接都会被 403 拒绝（R2-5）。
    const cap = TOOL_CAPABILITIES[tool];
    if (cap === 'write' || cap === undefined) {
      return {
        ok: false,
        httpStatus: 403,
        code: -32000,
        message: `Forbidden: read-only token cannot invoke "${tool}"`,
      };
    }
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

/**
 * 对一组 JSON-RPC 消息（含 batch 数组）逐条鉴权（蓝军 #10：JSON-RPC batch 绕过只读/批量确认）。
 * 单条消息与 evaluateAuthorization 同等严格；任一未授权即拒绝整批。
 * @param messages 单条消息对象数组（调用方负责把 body 归一化为数组）
 */
export function authorizeMessages(input: {
  presentedToken: string;
  confirmHeader: string;
  bearerToken: string;
  bearerTokenReadonly: string;
  bulkConfirmToken: string;
  messages: Array<{ method?: string; params?: { name?: string; arguments?: Record<string, any> } }>;
}): AuthDecision {
  for (const msg of input.messages) {
    const decision = evaluateAuthorization({
      presentedToken: input.presentedToken,
      tool: msg.method === 'tools/call' ? msg.params?.name : undefined,
      args: msg.method === 'tools/call' ? msg.params?.arguments : undefined,
      bearerToken: input.bearerToken,
      bearerTokenReadonly: input.bearerTokenReadonly,
      bulkConfirmToken: input.bulkConfirmToken,
      confirmHeader: input.confirmHeader,
    });
    if (!decision.ok) return decision;
  }
  return { ok: true };
}
