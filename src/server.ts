/**
 * @fileoverview MCP server configuration and tool registration.
 * Creates the MCP server instance and routes tool calls to handlers.
 * @module server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AccountPool } from './core/account-pool.js';
import { XhsDatabase } from './db/index.js';
import { accountTools, handleAccountTools } from './tools/account.js';
import { authTools, handleAuthTools } from './tools/auth.js';
import { contentTools, handleContentTools } from './tools/content.js';
import { publishTools, handlePublishTools } from './tools/publish.js';
import { interactionTools, handleInteractionTools } from './tools/interaction.js';
import { statsTools, handleStatsTools } from './tools/stats.js';
import { downloadTools, handleDownloadTools } from './tools/download.js';
import { draftTools, handleDraftTools } from './tools/draft.js';
import { creatorTools, handleCreatorTools } from './tools/creator.js';
import { notificationTools, handleNotificationTools } from './tools/notification.js';
import { exploreTools, handleExploreTools } from './tools/explore.js';
import { TOOL_CAPABILITIES } from './core/audit.js';

/** 蓝军 #1：启动期一次性扫描旧账号迁移状态，避免每次建连重复扫描 */
let migrationScanned = false;

// 写工具集合（P2-2 读写能力分级）定义于 core/audit.ts，此处再导出以兼容既有引用
export { WRITE_TOOL_NAMES } from './core/audit.js';

/**
 * Create and configure the MCP server.
 * Registers all available tools and sets up request handlers.
 *
 * @param pool - Account pool for managing XhsClient instances
 * @param db - Database instance for persistence
 * @returns Configured MCP Server instance
 */
export function createMcpServer(pool: AccountPool, db: XhsDatabase): Server {
  const server = new Server(
    {
      name: 'xhs-mcp',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Collect all tools from all modules
  const allTools = [
    ...accountTools,
    ...authTools,
    ...contentTools,
    ...publishTools,
    ...interactionTools,
    ...statsTools,
    ...downloadTools,
    ...draftTools,
    ...creatorTools,
    ...notificationTools,
    ...exploreTools,
  ];

  // 蓝军 P1 #11：所有注册工具必须显式声明能力，缺失（未知/未分类）即启动失败，
  // 以 fail-closed 兜底，避免新增工具默认被只读 token 直接调用。
  const unclassified = allTools.filter((t) => !(t.name in TOOL_CAPABILITIES));
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified tools (missing in core/audit.ts TOOL_CAPABILITIES): ${unclassified.map((t) => t.name).join(', ')}`,
    );
  }

  // 蓝军 #1：升级后尚无独立 profile 的旧账号强制进入 migration_required，拒绝平台操作
  if (!migrationScanned) {
    migrationScanned = true;
    try {
      const n = db.accounts.legacyProfilesRequireMigration();
      if (n > 0)
        console.warn(`[migration] ${n} 个旧账号缺少独立 profile，已置 migration_required，需人工重登录绑定`);
    } catch (e) {
      console.error('[migration] scan failed', e);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      // 蓝军 #7：普通 MCP 工具调用不得刷新「人工在场」确认，避免自动化客户端伪造值守。
      // 人工确认须由独立、短时、本地交互鉴权的通道刷新（见 core/liveness 的 recordHumanActivity），
      // 而非任意远程 MCP 调用。空闲超时（idleTimeoutMs）默认关闭，启用后仅由真实本地交互重置。
      const { name, arguments: args } = request.params;

      // Route to appropriate handler
      if (accountTools.some((t) => t.name === name)) {
        return await handleAccountTools(name, args, pool, db);
      }

      if (authTools.some((t) => t.name === name)) {
        return await handleAuthTools(name, args, pool, db);
      }

      if (contentTools.some((t) => t.name === name)) {
        return await handleContentTools(name, args, pool, db);
      }

      if (publishTools.some((t) => t.name === name)) {
        return await handlePublishTools(name, args, pool, db);
      }

      if (interactionTools.some((t) => t.name === name)) {
        return await handleInteractionTools(name, args, pool, db);
      }

      if (statsTools.some((t) => t.name === name)) {
        return await handleStatsTools(name, args, pool, db);
      }

      if (downloadTools.some((t) => t.name === name)) {
        return await handleDownloadTools(name, args, pool, db);
      }

      if (draftTools.some((t) => t.name === name)) {
        return await handleDraftTools(name, args, pool, db);
      }

      if (creatorTools.some((t) => t.name === name)) {
        return await handleCreatorTools(name, args, pool, db);
      }

      if (notificationTools.some((t) => t.name === name)) {
        return await handleNotificationTools(name, args, pool, db);
      }

      if (exploreTools.some((t) => t.name === name)) {
        return await handleExploreTools(name, args, pool, db);
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.message}`);
      }
      throw error;
    }
  });

  return server;
}
