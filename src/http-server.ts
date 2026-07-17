/**
 * @fileoverview HTTP transport server for the MCP protocol.
 * Provides a Hono-based HTTP server as an alternative to stdio transport.
 * Uses StreamableHTTPServerTransport for MCP communication.
 * @module http-server
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createMcpServer } from './server.js';
import { initDatabase } from './db/index.js';
import { getAccountPool } from './core/account-pool.js';
import { getLoginSessionManager } from './core/login-session.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { config } from './core/config.js';
import { evaluateAuthorization, authorizeMessages } from './core/audit.js';
import { startLivenessMonitor, recordHumanActivity, installPresenceSignal } from './core/liveness.js';

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
 * R3-1：人工在场确认 token。一次性随机生成，仅打印在本机终端（stderr），
 * 自动化 MCP 客户端读不到，故无法伪造「人工确认」。供 stdio（SIGUSR1）与 HTTP（/confirm-presence）共用。
 */
let _presenceSecret: string | null = null;
function getPresenceSecret(): string {
  if (!_presenceSecret) {
    _presenceSecret = randomBytes(16).toString('hex');
    console.error(`[presence] 人工在场确认 token（仅本机终端可见，勿外泄）: ${_presenceSecret}`);
  }
  return _presenceSecret;
}

/** R3-1：校验提供的人工在场 token 是否正确（供测试与路由共用） */
export function verifyPresenceToken(provided: string | undefined): boolean {
  const secret = _presenceSecret ?? getPresenceSecret();
  return !!provided && provided === secret;
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
  // R3-1：stdio 模式下无 HTTP 路由，故安装 SIGUSR1 信号作为本机人工在场确认通道
  installPresenceSignal();
  // 打印人工在场确认 token（仅本机终端可见，自动化客户端无法读取）
  getPresenceSecret();

  /**
   * Create a new MCP server and transport for each request.
   * In stateless HTTP mode, each request is independent.
   */
  const getOrCreateServer = async (): Promise<{ server: Server; transport: StreamableHTTPServerTransport }> => {
    // For stateless mode, we need a fresh transport per request
    // but can potentially reuse the server logic
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    // Create server if not exists, or create new one for each request in stateless mode
    // Note: In stateless HTTP mode, each request is independent
    const server = createMcpServer(pool, db);
    await server.connect(transport);

    return { server, transport };
  };

  const app = new Hono();

  // MCP 仅供本机进程调用，拒绝浏览器页面跨源触发写工具。
  app.use('/mcp', async (c, next) => {
    if (c.req.header('origin')) {
      return c.json({ error: 'Browser origins are not allowed' }, 403);
    }
    await next();
  });

  // MCP endpoint using StreamableHTTPServerTransport
  app.post('/mcp', async (c) => {
    let server: Server | null = null;
    let transport: StreamableHTTPServerTransport | null = null;

    try {
      // 先解析 body 再做 C3.3 鉴权/读写分级/批量确认（body 仅可读取一次，后续复用）
      const body = await c.req.json();
      const reject = authorizeMcp(c, body);
      if (reject) return reject;

      const result = await getOrCreateServer();
      server = result.server;
      transport = result.transport;

      // Get the raw request body (已提前解析并复用)

      // Create a mock Express-like request/response for the transport
      // StreamableHTTPServerTransport expects Express-style req/res
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const mockReq = {
        method: 'POST',
        headers,
        body,
      };

      let responseBody: any = null;
      let responseHeaders: Record<string, string> = {};
      let responseStatus = 200;
      let resolveResponse: () => void = () => undefined;
      const responseComplete = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });

      const mockRes = {
        writeHead: (status: number, headers?: Record<string, string>) => {
          responseStatus = status;
          if (headers) {
            responseHeaders = { ...responseHeaders, ...headers };
          }
          return mockRes;
        },
        setHeader: (name: string, value: string) => {
          responseHeaders[name] = value;
          return mockRes;
        },
        getHeader: (name: string) => responseHeaders[name],
        write: (chunk: string | Buffer) => {
          if (responseBody === null) {
            responseBody = '';
          }
          responseBody += typeof chunk === 'string' ? chunk : chunk.toString();
          return true;
        },
        end: (data?: string | Buffer) => {
          if (data) {
            if (responseBody === null) {
              responseBody = '';
            }
            responseBody += typeof data === 'string' ? data : data.toString();
          }
          resolveResponse();
          return mockRes;
        },
        on: () => mockRes,
        headersSent: false,
        flushHeaders: () => {},
      };

      await transport.handleRequest(mockReq as any, mockRes as any, body);
      await responseComplete;

      // Build response
      const response = new Response(responseBody, {
        status: responseStatus,
        headers: responseHeaders,
      });

      return response;
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
    } finally {
      // Clean up transport and server
      if (transport) {
        await transport.close().catch(() => {});
      }
      if (server) {
        await server.close().catch(() => {});
      }
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
    return c.json({ status: 'ok', server: 'xhs-mcp', version: '2.0.0' });
  });

  // R3-1：独立、本机「人工在场」确认通道。需携带本机终端打印的一次性 presence token，
  // 任意本地进程/自动化客户端读不到该 token，故无法伪造「人工确认」。
  // 用法（本机）：curl -X POST "http://127.0.0.1:<port>/confirm-presence?token=<secret>"
  //   或 Header：Authorization: Bearer <secret>
  app.post('/confirm-presence', (c) => {
    const url = new URL(c.req.url, `http://127.0.0.1:${config.server.port}`);
    const provided =
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || undefined;
    if (!verifyPresenceToken(provided)) {
      return c.json({ ok: false, error: 'forbidden: invalid or missing presence token' }, 401);
    }
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
