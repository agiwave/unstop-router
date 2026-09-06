export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
}

/** 单个真实后端服务配置 */
export interface EndpointConf {
  id: string;
  protocol: string;
  base_url: string;
  api_key: string;
  /** 上游真实模型名；空串表示与逻辑模型同名 */
  model: string;
  priority: number;
  enabled: boolean;
  timeout_ms: number;
  created_at: number;
}

export interface ModelConf {
  created_at: number;
  endpoints: EndpointConf[];
}

/**
 * KV 主存储文档：KV key = API Key 本身（sk-uns-...），
 * value = 该 Key 的全部配置（模型 + 每模型每协议的多组后端）。
 */
export interface ConfigDoc {
  name: string;
  prefix: string;
  created_at: number;
  models: Record<string, ModelConf>;
}

export interface UsageEntry {
  model: string;
  endpointId: string | null;
  protocol: string;
  status: 'success' | 'failed';
  statusCode: number | null;
  latencyMs: number;
  stream: boolean;
  error: string | null;
}

export interface RecentEntry {
  created_at: number;
  model_name: string;
  endpoint_id: string | null;
  protocol: string;
  status: string;
  status_code: number | null;
  latency_ms: number;
  stream: boolean;
  error: string | null;
}

/** 按天分桶的用量统计（stats:<apikey>:<YYYY-MM-DD>） */
export interface DayStats {
  day: string;
  total: number;
  ok: number;
  failed: number;
  latency_sum: number;
  recent: RecentEntry[];
}
