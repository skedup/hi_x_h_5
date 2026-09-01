import { describe, expect, test } from 'bun:test';

import { decodeRpcBody, renderLaunchAgent, renderSystemdUnit, summarizeStatus } from './kindred-operator.js';

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
    expect(summarizeStatus(true, 2, 1)).toContain('status=ok ');
    expect(summarizeStatus(false, 0, 0)).toContain('status=chrome_missing ');
    expect(summarizeStatus(true, 0, 0)).toContain('status=not_logged_in ');
  });
});
