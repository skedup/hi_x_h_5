/** Multi-account write proxy requirement mode. */
export type ProxyRequiredMode = 'off' | 'warn' | 'block';

/** Parse XHS_MCP_AD_PROXY_REQUIRED without importing runtime proxy/logging code. */
export function parseProxyRequiredMode(value: string | undefined): ProxyRequiredMode {
  if (value === undefined) return 'block';
  const normalized = value.toLowerCase().trim();
  if (['false', '0', 'off', 'no'].includes(normalized)) return 'off';
  if (['warn', 'warning'].includes(normalized)) return 'warn';
  return 'block';
}
