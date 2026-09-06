import { authenticate } from './auth';
import { recordUsage } from './kv';
import { PROTOCOLS, joinUrl, type ProtocolDef } from './protocols';
import type { EndpointConf, Env, UsageEntry } from './types';
import { CORS, json, now } from './util';

/**
 * 熔断器（进程内，best-effort）：
 * 失败后进入冷却期（30s × 连续失败次数，封顶 5 分钟），冷却期内优先跳过该后端；
 * 若其余后端全部失败，仍会回头把冷却中的后端再试一遍。
 */
interface BreakerState {
  fails: number;
  until: number;
}
const breaker = new Map<string, BreakerState>();

function isCooling(epId: string): boolean {
  const s = breaker.get(epId);
  return !!s && s.until > now();
}

function markFailure(epId: string): void {
  const s = breaker.get(epId) ?? { fails: 0, until: 0 };
  s.fails += 1;
  s.until = now() + Math.min(30_000 * s.fails, 300_000);
  breaker.set(epId, s);
}

function markSuccess(epId: string): void {
  breaker.delete(epId);
}

/** 上游返回这些状态码时切换下一个后端（401/403 多为该后端配置错误，也切换） */
const FAILOVER_STATUS = new Set([401, 403, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);

function openaiError(message: string, type = 'unstop_router_error', status = 500): Response {
  return json({ error: { message, type, code: null } }, status);
}

interface AttemptInfo {
  endpoint: string;
  status: number | null;
  latency_ms: number;
  error?: string;
}

export async function handleProxy(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) {
    return openaiError('Invalid or missing API key. Create one at the Unstop Router homepage.', 'authentication_error', 401);
  }
  const { key, config } = auth;
  const method = request.method;

  // OpenAI 风格：列出该 Key 下可用的逻辑模型
  if (path === '/v1/models' && method === 'GET') {
    const models = Object.entries(config.models)
      .sort((a, b) => a[1].created_at - b[1].created_at)
      .map(([name, m]) => ({
        id: name,
        object: 'model',
        created: Math.floor(m.created_at / 1000),
        owned_by: 'unstop-router',
      }));
    return json({ object: 'list', data: models });
  }

  // 根据路径确定协议
  let proto: ProtocolDef | null = null;
  for (const p of Object.values(PROTOCOLS)) {
    if (p.proxyPaths.includes(path)) {
      proto = p;
      break;
    }
  }
  if (!proto) {
    return openaiError(`Unknown endpoint: ${path}`, 'invalid_request_error', 404);
  }

  // 读取请求体，取出逻辑模型名
  const bodyText = method === 'POST' ? await request.text() : '';
  let logicalModel = '';
  let wantsStream = false;
  if (method === 'POST') {
    if (!bodyText) return openaiError('Request body is required.', 'invalid_request_error', 400);
    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return openaiError('Request body must be valid JSON.', 'invalid_request_error', 400);
    }
    logicalModel = String(parsed?.model ?? '');
    wantsStream = !!parsed?.stream;
    if (!logicalModel) return openaiError("'model' is required in request body.", 'invalid_request_error', 400);
  }

  const modelConf = config.models[logicalModel];
  if (!modelConf) {
    return openaiError(
      `Model '${logicalModel}' is not configured for this API key. Manage models at ${new URL(request.url).origin}/manage`,
      'invalid_request_error',
      404
    );
  }

  const list = modelConf.endpoints
    .filter((e) => e.enabled && e.protocol === proto!.id)
    .sort((a, b) => a.priority - b.priority || a.created_at - b.created_at);
  if (list.length === 0) {
    return openaiError(
      `No enabled upstream endpoint for model '${logicalModel}' (protocol ${proto!.id}). Add one in the management console.`,
      'unstop_router_error',
      503
    );
  }

  // 冷却中的后端排到后面，但仍保留为兜底
  const ordered: EndpointConf[] = [...list.filter((e) => !isCooling(e.id)), ...list.filter((e) => isCooling(e.id))];

  const attempts: AttemptInfo[] = [];

  const usage = (epId: string | null, status: 'success' | 'failed', statusCode: number | null, latencyMs: number, error: string | null) =>
    recordUsage(
      env,
      key,
      { model: logicalModel, endpointId: epId, protocol: proto!.id, status, statusCode, latencyMs, stream: wantsStream, error },
      ctx
    );

  for (const ep of ordered) {
    const t0 = now();
    const url = joinUrl(ep.base_url, proto.upstreamPath(path));
    const upstreamHeaders = new Headers({ 'content-type': 'application/json' });
    proto.applyAuth(upstreamHeaders, ep.api_key);

    try {
      const resp = await fetch(url, {
        method,
        headers: upstreamHeaders,
        body: method === 'POST' ? bodyText : undefined,
        signal: AbortSignal.timeout(ep.timeout_ms || 120000),
      });
      const latency = now() - t0;

      if (FAILOVER_STATUS.has(resp.status)) {
        const errText = await resp.text().catch(() => '');
        attempts.push({ endpoint: ep.id, status: resp.status, latency_ms: latency, error: errText.slice(0, 200) });
        markFailure(ep.id);
        usage(ep.id, 'failed', resp.status, latency, errText.slice(0, 200));
        continue; // 自动切换下一个后端
      }

      // 成功（或非切换类错误，如 400：调用方参数问题，原样透传）
      markSuccess(ep.id);
      usage(ep.id, 'success', resp.status, latency, null);

      const respHeaders = new Headers(resp.headers);
      // Worker 侧已解压，转发前删掉与传输相关的头
      respHeaders.delete('content-encoding');
      respHeaders.delete('content-length');
      respHeaders.delete('transfer-encoding');
      for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);
      respHeaders.set('x-unstop-served-by', ep.id);
      respHeaders.set('x-unstop-attempts', String(attempts.length + 1));
      // 注意：流式（SSE）响应的 body 会原样透传给调用方
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: respHeaders });
    } catch (e: any) {
      const latency = now() - t0;
      const msg = String(e?.message || e).slice(0, 200);
      attempts.push({ endpoint: ep.id, status: null, latency_ms: latency, error: msg });
      markFailure(ep.id);
      usage(ep.id, 'failed', null, latency, msg);
      continue; // 网络错误 / 超时 → 下一个后端
    }
  }

  return openaiError(
    `All ${ordered.length} upstream endpoint(s) failed for model '${logicalModel}'. Attempts: ${JSON.stringify(attempts)}`,
    'unstop_router_error',
    502
  );
}
