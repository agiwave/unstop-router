export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key',
  'access-control-max-age': '86400',
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export function now(): number {
  return Date.now();
}

export function newId(): string {
  return crypto.randomUUID();
}

/** 生成形如 sk-uns-<48位hex> 的 API Key（仅创建时返回一次，KV 以它为主键） */
export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'sk-uns-' + hex;
}

/** 展示用前缀，例如 sk-uns-9f2a...c41d */
export function keyPrefixOf(key: string): string {
  return key.slice(0, 12) + '...' + key.slice(-4);
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
