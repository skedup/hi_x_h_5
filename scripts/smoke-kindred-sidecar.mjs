/* global AbortSignal, console, fetch */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const protocolVersion = '2025-06-18';
const bearer = 'kindred-release-read-smoke';

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('failed to reserve a loopback port');
  return address.port;
}

async function rpc(baseUrl, id, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'mcp-protocol-version': protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  return response.json();
}

const dataDir = await mkdtemp(join(tmpdir(), 'kindred-xhs-release-smoke-'));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js', '--http', `--port=${port}`], {
  env: {
    ...process.env,
    XHS_MCP_DATA_DIR: dataDir,
    XHS_MCP_HEADLESS: 'true',
    XHS_MCP_HTTP_BEARER_READONLY: bearer,
    XHS_MCP_HTTP_BEARER: 'kindred-release-write-unused',
  },
  stdio: 'ignore',
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (health.ok) {
        ready = true;
        break;
      }
    } catch {
      // The child may still be starting.
    }
    await delay(100);
  }
  if (!ready) throw new Error('sidecar health did not become ready');

  const initialized = await rpc(baseUrl, 1, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'kindred-release-smoke', version: '1' },
  });
  if (initialized.result?.protocolVersion !== protocolVersion) throw new Error('initialize protocol mismatch');

  const listed = await rpc(baseUrl, 2, 'tools/list', {});
  const names = new Set(listed.result?.tools?.map((tool) => tool.name));
  for (const required of ['xhs_list_feeds', 'xhs_search', 'xhs_get_note']) {
    if (!names.has(required)) throw new Error(`tools/list is missing ${required}`);
  }
  console.log(`Kindred sidecar smoke passed: tools=${names.size}`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
}
