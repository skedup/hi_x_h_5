#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SERVICE_API_VERSION } from './service-api.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVICE_LABEL = 'com.kindred.xhs-mcp';

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as JsonObject;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function systemd(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function hasSystemChrome(): boolean {
  const candidates =
    platform() === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  return candidates.some(existsSync);
}

export function summarizeStatus(chrome: boolean, accounts: number, loggedIn: number): string {
  const status = !chrome ? 'chrome_missing' : loggedIn === 0 ? 'not_logged_in' : 'ok';
  return `status=${status} service_api_version=${SERVICE_API_VERSION} accounts=${accounts} logged_in=${loggedIn}`;
}

export function renderLaunchAgent(args: string[], dataDir: string, logDir: string): string {
  const argv = args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
${argv}
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>XHS_MCP_DATA_DIR</key><string>${xml(dataDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'stderr.log'))}</string>
</dict></plist>
`;
}

export function renderSystemdUnit(args: string[], dataDir: string): string {
  return `[Unit]
Description=Kindred Xiaohongshu MCP sidecar
After=network.target

[Service]
Type=simple
Environment=${systemd(`XHS_MCP_DATA_DIR=${dataDir}`)}
ExecStart=${args.map(systemd).join(' ')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function decodeRpcBody(contentType: string, body: string, requestId: number): JsonObject {
  let payload: unknown;
  if (contentType.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream') {
    const matches = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]')
      .map((line) => JSON.parse(line) as unknown)
      .filter((item) => object(item, 'MCP event').id === requestId);
    payload = matches.length === 1 ? matches[0] : null;
  } else {
    payload = JSON.parse(body) as unknown;
  }
  return object(payload, 'MCP response');
}

class McpClient {
  private requestId = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
  ) {}

  async connect(): Promise<JsonObject> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    const health = object(await response.json(), 'health response');
    if (health.status !== 'ok' || health.service_api_version !== SERVICE_API_VERSION) {
      throw new Error('service API version is incompatible');
    }
    await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'kindred-xhs-operator', version: '1.0.0' },
    });
    return health;
  }

  async callTool(name: string, args: JsonObject): Promise<JsonObject> {
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result.isError === true) throw new Error(`${name} returned an error`);
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) throw new Error(`${name} returned no content`);
    const first = object(content[0], `${name} content`);
    if (first.type !== 'text' || typeof first.text !== 'string')
      throw new Error(`${name} returned unsupported content`);
    return object(JSON.parse(first.text) as unknown, `${name} payload`);
  }

  private async rpc(method: string, params: JsonObject): Promise<JsonObject> {
    const id = ++this.requestId;
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) throw new Error(`MCP returned HTTP ${response.status}`);
    const payload = decodeRpcBody(response.headers.get('content-type') ?? '', await response.text(), id);
    if (payload.jsonrpc !== '2.0' || payload.id !== id) throw new Error('MCP response envelope is incompatible');
    if (payload.error !== undefined) throw new Error('MCP returned a JSON-RPC error');
    return object(payload.result, 'MCP result');
  }
}

function client(write: boolean): McpClient {
  const baseUrl = (process.env.XHS_MCP_URL || 'http://127.0.0.1:18060').replace(/\/$/, '');
  const token = write
    ? process.env.XHS_MCP_HTTP_BEARER
    : process.env.XHS_MCP_HTTP_BEARER_READONLY || process.env.XHS_MCP_HTTP_BEARER;
  return new McpClient(baseUrl, token);
}

async function status(): Promise<void> {
  const api = client(false);
  await api.connect();
  const accounts = await api.callTool('xhs_list_accounts', {});
  const count = typeof accounts.count === 'number' ? accounts.count : 0;
  const rows = Array.isArray(accounts.accounts) ? accounts.accounts : [];
  const loggedIn = rows.filter(
    (row) => typeof row === 'object' && row !== null && 'hasSession' in row && row.hasSession === true,
  ).length;
  const summary = summarizeStatus(hasSystemChrome(), count, loggedIn);
  console.log(summary);
  if (!summary.startsWith('status=ok ')) process.exitCode = 2;
}

async function login(): Promise<void> {
  if (!hasSystemChrome()) throw new Error('supported system Chrome is missing');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const api = client(true);
    await api.connect();
    const name = (await rl.question('Account name for re-login (blank for new): ')).trim();
    let state = await api.callTool('xhs_add_account', name ? { name } : {});
    const sessionId = state.sessionId;
    if (typeof sessionId !== 'string') throw new Error('login session is missing');
    if (typeof state.qrCodeUrl === 'string') console.log(`Scan this QR URL:\n${state.qrCodeUrl}`);
    while (true) {
      const loginStatus = state.status;
      if (loginStatus === 'success') {
        console.log('Login successful.');
        return;
      }
      if (loginStatus === 'expired' || loginStatus === 'failed') throw new Error(`login ${loginStatus}`);
      if (loginStatus === 'verification_required') {
        const code = (await rl.question('SMS verification code: ')).trim();
        state = await api.callTool('xhs_submit_verification', { sessionId, code });
      } else {
        await new Promise((done) => setTimeout(done, 3000));
        state = await api.callTool('xhs_check_login_session', { sessionId });
      }
    }
  } finally {
    rl.close();
  }
}

function installService(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const node = join(root, 'node', 'bin', 'node');
  const server = join(root, 'dist', 'index.js');
  if (!existsSync(node) || !existsSync(server)) throw new Error('install-service must run from a release bundle');
  const port = process.env.XHS_MCP_PORT || '18060';
  const dataDir = resolve(process.env.XHS_MCP_DATA_DIR || join(homedir(), '.xhs-mcp'));
  const logDir = join(dataDir, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const envFile = process.env.XHS_MCP_ENV_FILE;
  const args = [node, ...(envFile ? [`--env-file=${resolve(envFile)}`] : []), server, '--http', '--port', port];
  if (platform() === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderLaunchAgent(args, dataDir, logDir), { mode: 0o600 });
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.()}`, path], { stdio: 'ignore' });
    } catch {
      // The service may not have been loaded yet.
    }
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, path], { stdio: 'inherit' });
    console.log(`installed=${path}`);
  } else if (platform() === 'linux') {
    const path = join(homedir(), '.config', 'systemd', 'user', 'kindred-xhs-mcp.service');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSystemdUnit(args, dataDir), { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'kindred-xhs-mcp.service'], { stdio: 'inherit' });
    console.log(`installed=${path}`);
  } else {
    throw new Error(`unsupported platform: ${platform()}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'status') await status();
  else if (command === 'login') await login();
  else if (command === 'install-service') installService();
  else throw new Error('usage: kindred-xhs <install-service|status|login>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'operator failed');
    process.exitCode = 1;
  });
}
