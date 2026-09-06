/**
 * 协议注册表。
 * 每种协议定义：
 *  - 对外暴露的代理路径（调用方请求 Unstop Router 的路径）
 *  - 如何把代理路径换算成上游路径（配合 endpoint 的 base_url）
 *  - 如何把上游 apiKey 写进请求头
 *  - 连通性测试请求的构造方式
 */

export interface TestTarget {
  ep: { base_url: string; api_key: string; model: string };
  fallbackModel: string;
}

export interface ProtocolDef {
  id: string;
  label: string;
  description: string;
  baseUrlPlaceholder: string;
  proxyPaths: string[];
  /** 把对外代理路径映射为上游路径 */
  upstreamPath: (path: string) => string;
  applyAuth: (headers: Headers, apiKey: string) => void;
  buildTest: (t: TestTarget) => { path: string; body: unknown; extract: (j: any) => string | undefined };
}

export const PROTOCOLS: Record<string, ProtocolDef> = {
  openai_compatible: {
    id: 'openai_compatible',
    label: 'OpenAI 兼容',
    description:
      '适用于 OpenAI / DeepSeek / Moonshot / 阿里百炼 / SiliconFlow / 自建 vLLM 等。Base URL 通常以 /v1 结尾，例如 https://api.deepseek.com/v1。',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    proxyPaths: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings'],
    upstreamPath: (p) => p.replace(/^\/v1/, ''),
    applyAuth: (h, k) => h.set('Authorization', 'Bearer ' + k),
    buildTest: ({ ep, fallbackModel }) => ({
      path: '/chat/completions',
      body: {
        model: ep.model || fallbackModel,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
        stream: false,
      },
      extract: (j) => j?.choices?.[0]?.message?.content,
    }),
  },
  anthropic_compatible: {
    id: 'anthropic_compatible',
    label: 'Anthropic 兼容',
    description:
      '适用于 Claude 系列及兼容 Anthropic Messages API 的服务。Base URL 不带 /v1，例如 https://api.anthropic.com。',
    baseUrlPlaceholder: 'https://api.anthropic.com',
    proxyPaths: ['/v1/messages'],
    upstreamPath: (p) => p,
    applyAuth: (h, k) => {
      h.set('x-api-key', k);
      h.set('anthropic-version', '2023-06-01');
    },
    buildTest: ({ ep, fallbackModel }) => ({
      path: '/v1/messages',
      body: {
        model: ep.model || fallbackModel,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
      },
      extract: (j) => j?.content?.[0]?.text,
    }),
  },
};

export function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed + (path.startsWith('/') ? path : '/' + path);
}

/** 对某个 endpoint 发起一次真实的小请求，验证连通性（管理台"测试"按钮） */
export async function testEndpoint(
  ep: { id: string; protocol: string; base_url: string; api_key: string; model: string; timeout_ms: number },
  fallbackModel: string
): Promise<{ ok: boolean; status_code?: number; latency_ms: number; error?: string; sample?: string }> {
  const def = PROTOCOLS[ep.protocol];
  if (!def) return { ok: false, latency_ms: 0, error: `未知协议: ${ep.protocol}` };

  const target = def.buildTest({ ep, fallbackModel });
  const headers = new Headers({ 'content-type': 'application/json' });
  def.applyAuth(headers, ep.api_key);
  const url = joinUrl(ep.base_url, target.path);
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(target.body),
      signal: AbortSignal.timeout(Math.min(ep.timeout_ms || 120000, 20000)),
    });
    const text = await resp.text();
    const latency = Date.now() - started;
    if (!resp.ok) {
      return { ok: false, status_code: resp.status, latency_ms: latency, error: truncate(text, 300) };
    }
    try {
      const parsed = JSON.parse(text);
      const sample = target.extract(parsed);
      return { ok: true, status_code: resp.status, latency_ms: latency, sample: sample ? truncate(sample, 200) : undefined };
    } catch {
      return { ok: true, status_code: resp.status, latency_ms: latency, sample: truncate(text, 200) };
    }
  } catch (e: any) {
    return { ok: false, latency_ms: Date.now() - started, error: truncate(String(e?.message || e), 300) };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
