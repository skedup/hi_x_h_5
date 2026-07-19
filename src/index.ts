#!/usr/bin/env node
/**
 * @fileoverview Entry point for the xhs-mcp server.
 * Supports both stdio and HTTP transport modes.
 * @module index
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { initDatabase } from './db/index.js';
import { getAccountPool } from './core/account-pool.js';
import { startHttpServer } from './http-server.js';
import { config } from './core/config.js';
import { startLivenessMonitor, installPresenceSignal } from './core/liveness.js';

/**
 * Parse command line arguments.
 * @returns Parsed options for server startup
 */
function parseArgs(): { http: boolean; port: number } {
  const args = process.argv.slice(2);
  let http = false;
  let port = config.server.port; // 使用配置中的默认端口

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--http' || arg === '-h') {
      http = true;
    } else if (arg === '--port' || arg === '-p') {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        port = parseInt(nextArg, 10);
        i++;
      }
    } else if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10);
    }
  }

  return { http, port };
}

/**
 * Run the MCP server in stdio mode.
 * Connects via stdin/stdout for communication with MCP clients.
 */
async function runStdioMode() {
  // Initialize database
  const db = await initDatabase();
  const pool = getAccountPool(db);

  const server = createMcpServer(pool, db);
  const transport = new StdioServerTransport();

  // C3.2 启动息屏自保轮询（darwin + 已启用时生效；非 darwin/未启用为 no-op）
  await startLivenessMonitor();
  // R3-1：stdio 模式下无 HTTP /confirm-presence 路由，改用 SIGUSR1 信号作为本机人工在场确认通道
  installPresenceSignal();

  await server.connect(transport);
  console.error('Xiaohongshu MCP Server running on stdio');

  // Graceful shutdown
  const shutdown = async () => {
    console.error('Shutting down...');
    await pool.closeAll();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Main entry point.
 * Starts the server in either stdio or HTTP mode based on command line arguments.
 */
async function main() {
  const { http, port } = parseArgs();

  if (http) {
    await startHttpServer(port);
  } else {
    await runStdioMode();
  }
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
