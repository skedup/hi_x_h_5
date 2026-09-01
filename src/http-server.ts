/**
 * @fileoverview HTTP transport server for the MCP protocol.
 * Provides a Hono-based HTTP server as an alternative to stdio transport.
 * Uses the MCP Web Standard transport for Hono request/response handling.
 * @module http-server
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createMcpServer } from './server.js';
import { initDatabase, type XhsDatabase } from './db/index.js';
import { getAccountPool, type AccountPool } from './core/account-pool.js';
import { getLoginSessionManager } from './core/login-session.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { config } from './core/config.js';
import { authorizeMessages } from './core/audit.js';
import { startLivenessMonitor, recordHumanActivity, installPresenceSignal } from './core/liveness.js';
import { SERVICE_API_VERSION } from './service-api.js';

export function healthPayload() {
  return {
    status: 'ok',
    server: 'xhs-mcp',
    version: '2.0.0',
    service_api_version: SERVICE_API_VERSION,
  };
}

/**
 * C3.3（P2-2）本地 HTTP MCP 鉴权与读写能力分级。
 * 返回 null 表示放行；否则返回应直接返回的 JSON-RPC 错误 Response。
 */
function jsonRpcError(c: Context, code: number, message: string, httpStatus: number): Response {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, httpStatus as 401 | 403);
}

function authorizeMcp(c: Context, body: any): Response | null {
  const { bearerToken, bearerTokenReadonly, bulkConfirmToken } = config.server;

  const authz = c.req.header('authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  const presented = m ? m[1].trim() : '';
  const confirmHeader = c.req.header('x-xhs-write-confirm') || '';

  // 蓝军 #10：body 可能是 batch 数组，逐条鉴权，任一未授权即拒绝整批
  const messages = Array.isArray(body) ? body : [body];
  const decision = authorizeMessages({
    presentedToken: presented,
    confirmHeader,
    bearerToken,
    bearerTokenReadonly,
    bulkConfirmToken,
    messages,
  });

  if (!decision.ok) {
    return jsonRpcError(c, decision.code ?? -32000, decision.message ?? 'Forbidden', decision.httpStatus ?? 403);
  }
  return null;
}

/**
 * R4 P2 1019839888：人工在场确认 challenge。
 * - 短时有效（server.presenceChallengeTtlMs），过期即失效；
 * - 消费（验证成功）后轮换为新 challenge，旧 token 立即作废；
 * - 仅打印在本机终端 stderr，自动化 MCP 客户端读不到，但仍需本机交互才能取得，
 *   故作为「本地人工在场」的弱门禁，而非「自动化无法伪造」的强证明。
 * 与 stdio 的 SIGUSR1 不同，本 challenge 有时效与轮换，适合承担可控门禁语义。
 */
interface PresenceChallenge {
  secret: string;
  expiresAt: number;
}
let _presence: PresenceChallenge | null = null;

function getPresenceChallenge(): PresenceChallenge {
  const now = Date.now();
  if (!_presence || _presence.expiresAt <= now) {
    _presence = {
      secret: randomBytes(16).toString('hex'),
      expiresAt: now + config.server.presenceChallengeTtlMs,
    };
    console.error(
      `[presence] 人工在场确认 token（仅本机终端可见，短时有效 ${config.server.presenceChallengeTtlMs}ms，消费后轮换）: ${_presence.secret}`,
    );
  }
  return _presence;
}

/** 校验提供的人工在场 token：失败或过期即拒绝；成功则轮换（旧 token 作废）。供测试与路由共用。 */
export function verifyPresenceToken(provided: string | undefined): boolean {
  // 每次都经过 getPresenceChallenge；已有 challenge 自然过期时会生成并打印新值，
  // 避免 _presence 非空但已过期后永久 401，必须重启服务才能恢复。
  const ch = getPresenceChallenge();
  if (!provided || provided !== ch.secret) return false;
  if (ch.expiresAt <= Date.now()) return false;
  // 消费后轮换，旧 token 立即失效
  _presence = null;
  return true;
}

export async function handleMcpRequest(
  request: Request,
  body: unknown,
  pool: AccountPool,
  db: XhsDatabase,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer(pool, db);

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/**
 * Start the HTTP transport server for the MCP protocol.
 * Uses Hono as the HTTP framework and Node.js as the runtime.
 *
 * @param port - Port number to listen on (default: 18060)
 */
export async function startHttpServer(port: number = config.server.port) {
  // Initialize database and account pool
  const db = await initDatabase();
  const pool = getAccountPool(db);

  // C3.2 启动息屏自保轮询（darwin + 已启用时生效；非 darwin/未启用为 no-op）
  await startLivenessMonitor();
  // R4 P2：stdio 模式下无 HTTP 路由，安装 SIGUSR1 仅作开发期提示（无鉴权，不重置空闲计时，不构成门禁）
  installPresenceSignal();
  // 打印人工在场确认 challenge（仅本机终端可见；短时有效、消费后轮换，自动化客户端无法读取）
  getPresenceChallenge();

  const app = new Hono();

  // MCP 仅供本机进程调用，拒绝浏览器页面跨源触发写工具。
  app.use('/mcp', async (c, next) => {
    if (c.req.header('origin')) {
      return c.json({ error: 'Browser origins are not allowed' }, 403);
    }
    await next();
  });

  // Each request gets an independent stateless MCP server and transport.
  app.post('/mcp', async (c) => {
    try {
      // 先解析 body 再做 C3.3 鉴权/读写分级/批量确认（body 仅可读取一次，后续复用）
      const body = await c.req.json();
      const reject = authorizeMcp(c, body);
      if (reject) return reject;
      return await handleMcpRequest(c.req.raw, body, pool, db);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        },
        500,
      );
    }
  });

  // Method not allowed for GET/DELETE
  app.get('/mcp', (c) => {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      },
      405,
    );
  });

  app.delete('/mcp', (c) => {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      },
      405,
    );
  });

  // Health check endpoint
  app.get('/health', (c) => {
    return c.json(healthPayload());
  });

  // R4 P2 1019839888：独立、本机「人工在场」确认通道。需携带本机终端打印的短时 challenge token
  // （短时有效、消费后轮换），任意本地进程/自动化客户端读不到该 token，故不能由远程 MCP 调用伪造。
  // 用法（本机）：curl -X POST "http://127.0.0.1:<port>/confirm-presence?token=<secret>"
  //   或 Header：Authorization: Bearer <secret>
  app.post('/confirm-presence', (c) => {
    const url = new URL(c.req.url, `http://127.0.0.1:${config.server.port}`);
    const provided =
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || undefined;
    if (!verifyPresenceToken(provided)) {
      return c.json({ ok: false, error: 'forbidden: invalid, missing or expired presence token' }, 401);
    }
    // 真实本地交互成功 → 重置空闲计时（仅此通道可重置，普通 MCP 工具调用不会刷新）
    recordHumanActivity();
    return c.json({ ok: true, message: 'presence confirmed' });
  });

  // Info endpoint
  app.get('/', (c) => {
    return c.json({
      name: 'xhs-mcp',
      version: '2.0.0',
      description: 'Xiaohongshu MCP Server with Multi-Account Support',
      endpoints: {
        mcp: '/mcp',
        health: '/health',
      },
    });
  });

  console.error(`Starting HTTP server on port ${port}...`);
  console.error(`MCP endpoint: http://localhost:${port}/mcp`);

  const httpServer = serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error('Shutting down HTTP server...');
    await getLoginSessionManager().shutdown();
    await pool.closeAll();
    db.close();
    httpServer.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.error(`HTTP server running on http://localhost:${port}`);
}
