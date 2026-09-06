import type { ConfigDoc, Env } from './types';
import { getConfig } from './kv';

function extractKey(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const xKey = request.headers.get('x-api-key');
  if (xKey && xKey.trim()) return xKey.trim();
  return null;
}

export interface AuthContext {
  key: string;
  config: ConfigDoc;
}

/**
 * API Key 即 KV 主键：用请求携带的 Key 直接读取 KV，
 * 能取到配置即为合法（无需哈希查询，一次读取同时拿到全部路由配置）。
 */
export async function authenticate(request: Request, env: Env): Promise<AuthContext | null> {
  const raw = extractKey(request);
  if (!raw || !raw.startsWith('sk-uns-')) return null;
  const config = await getConfig(env, raw);
  return config ? { key: raw, config } : null;
}
