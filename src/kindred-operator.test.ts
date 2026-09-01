import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodeRpcBody,
  loadOperatorEnvironment,
  operatorBaseUrl,
  renderLaunchAgent,
  renderSystemdUnit,
  summarizeStatus,
  systemdActivationCommands,
} from './kindred-operator.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Kindred sidecar operator', () => {
  test('renders fixed launchd and systemd services', () => {
    const args = ['/release/node/bin/node', '/release/dist/index.js', '--http', '--port', '18060'];
    const launchd = renderLaunchAgent(args, '/life/state/xhs', '/life/state/xhs/logs');
    const unit = renderSystemdUnit(args, '/life/state/xhs');

    expect(launchd).toContain('<string>/release/dist/index.js</string>');
    expect(launchd).toContain('<key>XHS_MCP_DATA_DIR</key><string>/life/state/xhs</string>');
    expect(unit).toContain('ExecStart="/release/node/bin/node" "/release/dist/index.js"');
    expect(unit).toContain('Environment="XHS_MCP_DATA_DIR=/life/state/xhs"');
    expect(unit).not.toContain('uninstall');
    expect(systemdActivationCommands()).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'kindred-xhs-mcp.service'],
      ['--user', 'restart', 'kindred-xhs-mcp.service'],
    ]);
  });

  test('loads the service env file without overriding explicit operator variables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kindred-xhs-env-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'xhs.env');
    writeFileSync(path, 'XHS_MCP_HTTP_BEARER=file-secret\nXHS_MCP_PORT=19060\n');
    const env: NodeJS.ProcessEnv = { XHS_MCP_PORT: '20060' };

    loadOperatorEnvironment(path, env);

    expect(env).toEqual({ XHS_MCP_PORT: '20060', XHS_MCP_HTTP_BEARER: 'file-secret' });
  });

  test('uses the service port by default and rejects non-loopback URLs', () => {
    expect(operatorBaseUrl({ XHS_MCP_PORT: '19060' })).toBe('http://127.0.0.1:19060');
    expect(operatorBaseUrl({ XHS_MCP_URL: 'http://localhost:19060/' })).toBe(
      'http://localhost:19060',
    );
    expect(() => operatorBaseUrl({ XHS_MCP_URL: 'https://example.com' })).toThrow('loopback');
    expect(() => operatorBaseUrl({ XHS_MCP_URL: 'http://127.0.0.1:19060/path' })).toThrow(
      'loopback',
    );
    expect(() => operatorBaseUrl({ XHS_MCP_PORT: '70000' })).toThrow('between 1 and 65535');
  });

  test('decodes JSON and SSE responses by request id', () => {
    expect(decodeRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}', 1).id).toBe(1);
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    expect(decodeRpcBody('text/event-stream; charset=utf-8', sse, 2).id).toBe(2);
  });

  test('rejects ambiguous SSE responses', () => {
    const sse = 'data: {"id":3}\n\ndata: {"id":3}\n\n';
    expect(() => decodeRpcBody('text/event-stream', sse, 3)).toThrow('MCP response is malformed');
  });

  test('distinguishes ready, missing Chrome, and not logged in', () => {
    expect(summarizeStatus(true, 2, 1)).toContain('status=session_present ');
    expect(summarizeStatus(true, 2, 1)).toContain('sessions=1 login=unverified');
    expect(summarizeStatus(false, 0, 0)).toContain('status=chrome_missing ');
    expect(summarizeStatus(true, 0, 0)).toContain('status=login_required ');
  });
});
