import type { ConfigDoc, DayStats, Env, RecentEntry, UsageEntry } from './types';
import { now } from './util';

const RECENT_LIMIT = 50;
const FLUSH_INTERVAL_MS = 2000;

/* ---------------- 配置文档（KV key = API Key 本身） ---------------- */

export async function getConfig(env: Env, apiKey: string): Promise<ConfigDoc | null> {
  return env.KV.get(apiKey, 'json');
}

export async function putConfig(env: Env, apiKey: string, cfg: ConfigDoc): Promise<void> {
  await env.KV.put(apiKey, JSON.stringify(cfg));
}

/* ---------------- 用量统计（按天分桶：stats:<apikey>:<YYYY-MM-DD>） ----------------
 * KV 对同一个 key 的写入约 1 次/秒，因此本 isolate 内先聚合，
 * 最多每 2 秒 flush 一次（read-modify-write，best-effort，可能少量丢计数）。 */

function emptyBucket(day: string): DayStats {
  return { day, total: 0, ok: 0, failed: 0, latency_sum: 0, recent: [] };
}

function ymd(ts = now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const pending = new Map<string, { buckets: Map<string, DayStats>; lastFlush: number }>();

export function recordUsage(env: Env, apiKey: string, entry: UsageEntry, ctx: ExecutionContext): void {
  const day = ymd();
  let p = pending.get(apiKey);
  if (!p) {
    p = { buckets: new Map(), lastFlush: 0 };
    pending.set(apiKey, p);
  }
  let bucket = p.buckets.get(day);
  if (!bucket) {
    bucket = emptyBucket(day);
    p.buckets.set(day, bucket);
  }
  bucket.total += 1;
  if (entry.status === 'success') bucket.ok += 1;
  else bucket.failed += 1;
  bucket.latency_sum += entry.latencyMs;
  const rec: RecentEntry = {
    created_at: now(),
    model_name: entry.model,
    endpoint_id: entry.endpointId,
    protocol: entry.protocol,
    status: entry.status,
    status_code: entry.statusCode,
    latency_ms: entry.latencyMs,
    stream: entry.stream,
    error: entry.error,
  };
  bucket.recent.unshift(rec);
  if (bucket.recent.length > RECENT_LIMIT) bucket.recent.length = RECENT_LIMIT;

  const t = now();
  if (t - p.lastFlush >= FLUSH_INTERVAL_MS) {
    p.lastFlush = t;
    const snapshot = new Map(p.buckets);
    p.buckets.clear();
    ctx.waitUntil(flushStats(env, apiKey, snapshot));
  }
}

async function flushStats(env: Env, apiKey: string, buckets: Map<string, DayStats>): Promise<void> {
  for (const [day, inc] of buckets) {
    const key = `stats:${apiKey}:${day}`;
    try {
      const cur: DayStats = (await env.KV.get(key, 'json')) ?? emptyBucket(day);
      cur.day = day;
      cur.total += inc.total;
      cur.ok += inc.ok;
      cur.failed += inc.failed;
      cur.latency_sum += inc.latency_sum;
      cur.recent = [...inc.recent, ...(cur.recent ?? [])].slice(0, RECENT_LIMIT);
      await env.KV.put(key, JSON.stringify(cur));
    } catch (e) {
      console.error('flushStats failed', e);
    }
  }
}

export interface StatsSummary {
  days: Array<{ day: string; total: number; ok: number; failed: number; avg_latency_ms: number | null }>;
  recent: RecentEntry[];
  request_count: number;
  last_used_at: number | null;
}

export async function collectStats(env: Env, apiKey: string): Promise<StatsSummary> {
  const prefix = `stats:${apiKey}:`;
  const listing = await env.KV.list({ prefix, limit: 60 });
  const days: Array<any> = [];
  for (const k of listing.keys) {
    const day = k.name.slice(prefix.length);
    const v: DayStats = (await env.KV.get(k.name, 'json')) ?? emptyBucket(day);
    days.push({
      day,
      total: v.total,
      ok: v.ok,
      failed: v.failed,
      avg_latency_ms: v.total ? Math.round(v.latency_sum / v.total) : null,
      _recent: v.recent ?? [],
    });
  }
  days.sort((a, b) => (a.day < b.day ? 1 : -1));
  const recent: RecentEntry[] = days.flatMap((d) => d._recent).slice(0, 30);
  for (const d of days) delete d._recent;
  const request_count = days.reduce((s, d) => s + (d.total || 0), 0);
  const last_used_at = recent.length ? recent[0].created_at : null;
  return { days, recent, request_count, last_used_at };
}
