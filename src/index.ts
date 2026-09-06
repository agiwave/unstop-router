import { handleAdmin } from './admin';
import { handleProxy } from './proxy';
import type { Env } from './types';
import { CORS, corsPreflight, json } from './util';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'OPTIONS') return corsPreflight();
      if (path === '/health') {
        return json({ ok: true, service: 'unstop-router', time: new Date().toISOString() });
      }
      if (path.startsWith('/api/')) return await handleAdmin(request, env, ctx, path);
      if (path.startsWith('/v1/')) return await handleProxy(request, env, ctx, path);
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
