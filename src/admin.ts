import { authenticate } from './auth';
import { collectStats, putConfig } from './kv';
import { PROTOCOLS, testEndpoint } from './protocols';
import type { ConfigDoc, EndpointConf, Env, ModelConf } from './types';
import { clampInt, generateApiKey, json, keyPrefixOf, newId, now, readJson } from './util';

const MODEL_NAME_RE = /^[A-Za-z0-9_.:\-/]{1,128}$/;

interface EndpointInput {
  protocol: string;
  base_url: string;
  api_key: string;
  model: string;
  priority: number;
  enabled: boolean;
  timeout_ms: number;
}

function normalizeEndpoint(body: any): { ok: true; value: EndpointInput } | { ok: false; error: string } {
  const protocol = String(body?.protocol || 'openai_compatible');
  if (!PROTOCOLS[protocol]) return { ok: false, error: `不支持的协议: ${protocol}` };
  let base = String(body?.base_url || '').trim();
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Base URL 必须以 http:// 或 https:// 开头' };
  if (base.length > 512) return { ok: false, error: 'Base URL 过长' };
  base = base.replace(/\/+$/, '');
  const value: EndpointInput = {
    protocol,
    base_url: base,
    api_key: String(body?.api_key ?? '').slice(0, 512),
    model: String(body?.model ?? '').trim().slice(0, 256),
    priority: clampInt(body?.priority, 0, 9999, 0),
    enabled: body?.enabled === undefined ? true : !!body?.enabled,
    timeout_ms: clampInt(body?.timeout_ms, 1000, 600000, 120000),
  };
  return { ok: true, value };
}

function sortedEndpoints(m: ModelConf): EndpointConf[] {
  return [...m.endpoints].sort((a, b) => a.priority - b.priority || a.created_at - b.created_at);
}

function findEndpoint(cfg: ConfigDoc, endpointId: string): { modelName: string; ep: EndpointConf } | null {
  for (const [modelName, m] of Object.entries(cfg.models)) {
    const ep = m.endpoints.find((e) => e.id === endpointId);
    if (ep) return { modelName, ep };
  }
  return null;
}

export async function handleAdmin(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const method = request.method;

  // ---------- 公开接口：创建 / 校验 API Key ----------
  if (path === '/api/keys' && method === 'POST') {
    const body = await readJson<{ name?: string }>(request);
    const name = (body.name || '').trim().slice(0, 64) || 'default';
    const rawKey = generateApiKey();
    const cfg: ConfigDoc = {
      name,
      prefix: keyPrefixOf(rawKey),
      created_at: now(),
      models: {},
    };
    await putConfig(env, rawKey, cfg);
    return json({ key: rawKey, prefix: cfg.prefix, name }, 201);
  }

  if (path === '/api/keys/verify' && method === 'POST') {
    const body = await readJson<{ key?: string }>(request);
    const raw = (body.key || '').trim();
    if (!raw) return json({ ok: false, error: '请输入 API Key' }, 400);
    const cfg = await env.KV.get<ConfigDoc>(raw, 'json');
    if (!cfg) return json({ ok: false, error: 'API Key 不存在或已失效' }, 404);
    return json({ ok: true, name: cfg.name, prefix: cfg.prefix, created_at: cfg.created_at });
  }

  if (path === '/api/protocols' && method === 'GET') {
    return json({
      protocols: Object.values(PROTOCOLS).map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        base_url_placeholder: p.baseUrlPlaceholder,
        proxy_paths: p.proxyPaths,
      })),
    });
  }

  // ---------- 以下接口均需 API Key（Key 本身即定位到其配置文档） ----------
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: { message: 'Unauthorized: missing or invalid API key' } }, 401);
  const { key, config } = auth;
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  if (path === '/api/bootstrap' && method === 'GET') {
    const stats = await collectStats(env, key);
    return json({
      key: {
        name: config.name,
        prefix: config.prefix,
        created_at: config.created_at,
        last_used_at: stats.last_used_at,
        request_count: stats.request_count,
      },
      base_url: new URL(request.url).origin + '/v1',
      protocols: Object.values(PROTOCOLS).map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        base_url_placeholder: p.baseUrlPlaceholder,
        proxy_paths: p.proxyPaths,
      })),
      models: Object.entries(config.models)
        .map(([name, m]) => ({ id: name, name, created_at: m.created_at, endpoints: sortedEndpoints(m) }))
        .sort((a, b) => a.created_at - b.created_at),
      stats: { days: stats.days, recent: stats.recent },
    });
  }

  if (path === '/api/stats' && method === 'GET') {
    const stats = await collectStats(env, key);
    return json({ days: stats.days, recent: stats.recent });
  }

  // ---------- 模型 CRUD（模型名即 ID） ----------
  if (path === '/api/models' && method === 'POST') {
    const body = await readJson<{ name?: string }>(request);
    const name = (body.name || '').trim();
    if (!MODEL_NAME_RE.test(name)) {
      return json({ error: { message: '模型名称需为 1-128 位字母、数字或 - _ . : /' } }, 400);
    }
    if (config.models[name]) return json({ error: { message: `模型 ${name} 已存在` } }, 409);
    config.models[name] = { created_at: now(), endpoints: [] };
    await putConfig(env, key, config);
    return json({ id: name, name }, 201);
  }

  if (seg[0] === 'api' && seg[1] === 'models' && seg.length === 3) {
    const modelName = decodeURIComponent(seg[2]);
    if (method === 'PUT') {
      const m = config.models[modelName];
      if (!m) return json({ error: { message: '模型不存在' } }, 404);
      const body = await readJson<{ name?: string }>(request);
      const newName = (body.name || '').trim();
      if (!MODEL_NAME_RE.test(newName)) return json({ error: { message: '模型名称不合法' } }, 400);
      if (newName !== modelName && config.models[newName]) {
        return json({ error: { message: `模型 ${newName} 已存在` } }, 409);
      }
      delete config.models[modelName];
      config.models[newName] = m;
      await putConfig(env, key, config);
      return json({ id: newName, name: newName });
    }
    if (method === 'DELETE') {
      if (!config.models[modelName]) return json({ error: { message: '模型不存在' } }, 404);
      delete config.models[modelName];
      await putConfig(env, key, config);
      return json({ ok: true });
    }
  }

  // ---------- 后端服务（endpoints）CRUD ----------
  // POST /api/models/:name/endpoints
  if (seg[0] === 'api' && seg[1] === 'models' && seg[3] === 'endpoints' && seg.length === 4 && method === 'POST') {
    const modelName = decodeURIComponent(seg[2]);
    const m = config.models[modelName];
    if (!m) return json({ error: { message: '模型不存在' } }, 404);
    const body = await readJson<any>(request);
    const norm = normalizeEndpoint(body);
    if (!norm.ok) return json({ error: { message: norm.error } }, 400);
    const ep: EndpointConf = { id: newId(), created_at: now(), ...norm.value };
    m.endpoints.push(ep);
    await putConfig(env, key, config);
    return json(ep, 201);
  }

  // PUT/DELETE /api/endpoints/:id  POST /api/endpoints/:id/test
  if (seg[0] === 'api' && seg[1] === 'endpoints' && seg.length >= 3) {
    const epId = seg[2];
    const found = findEndpoint(config, epId);
    if (!found) return json({ error: { message: '后端服务不存在' } }, 404);

    if (seg.length === 3 && method === 'PUT') {
      const body = await readJson<any>(request);
      const merged = {
        protocol: body.protocol ?? found.ep.protocol,
        base_url: body.base_url ?? found.ep.base_url,
        api_key: body.api_key ?? found.ep.api_key,
        model: body.model ?? found.ep.model,
        priority: body.priority ?? found.ep.priority,
        enabled: body.enabled ?? found.ep.enabled,
        timeout_ms: body.timeout_ms ?? found.ep.timeout_ms,
      };
      const norm = normalizeEndpoint(merged);
      if (!norm.ok) return json({ error: { message: norm.error } }, 400);
      Object.assign(found.ep, norm.value);
      await putConfig(env, key, config);
      return json(found.ep);
    }
    if (seg.length === 3 && method === 'DELETE') {
      const m = config.models[found.modelName];
      m.endpoints = m.endpoints.filter((e) => e.id !== epId);
      await putConfig(env, key, config);
      return json({ ok: true });
    }
    if (seg.length === 4 && seg[3] === 'test' && method === 'POST') {
      const result = await testEndpoint(found.ep, found.modelName);
      return json(result);
    }
  }

  return json({ error: { message: `Not found: ${method} ${path}` } }, 404);
}
