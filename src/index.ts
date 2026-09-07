import { handleAdmin } from './admin';
import { handleProxy } from './proxy';
import { authenticate } from './auth';
import { getWhitelist } from './kv';
import type { Env } from './types';
import { CORS, corsPreflight, json } from './util';

function openaiError(message: string, type = 'unstop_router_error', status = 500): Response {
  return json({ error: { message, type, code: null } }, status, CORS);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'OPTIONS') return corsPreflight();
      if (path === '/health') {
        return json({ ok: true, service: 'unstop-router', time: new Date().toISOString() });
      }

      // 生成新 API Key（公开，无需鉴权）
      if (path === '/api/keys' && request.method === 'POST') {
        return await handleAdmin(request, env, ctx, path);
      }

      // 其余 /api 和 /v1 接口均需鉴权 + 白名单
      if (path.startsWith('/api/') || path.startsWith('/v1/')) {
        const auth = await authenticate(request, env);
        if (!auth) {
          return openaiError('Invalid or missing API key.', 'authentication_error', 401);
        }

        // 白名单校验（白名单为空时不限制）
        const whitelist = await getWhitelist(env);
        if (whitelist.length > 0 && !whitelist.includes(auth.key)) {
          return openaiError(
            'This API key is not authorized. Contact the administrator to add it to the whitelist.',
            'authorization_error',
            403
          );
        }

        if (path.startsWith('/v1/')) {
          return await handleProxy(request, env, ctx, path, auth);
        }
        return await handleAdmin(request, env, ctx, path, auth);
      }

      // 其余路径交给静态资源（首页 /manage 等），未匹配则 404
      return env.ASSETS.fetch(request);
    } catch (err: any) {
      console.error('unhandled error', err);
      return json(
        { error: { message: 'Internal error: ' + (err?.message || String(err)), type: 'unstop_router_error' } },
        500,
        CORS
      );
    }
  },
} satisfies ExportedHandler<Env>;
