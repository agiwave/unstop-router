# Unstop Router

**永不停站的 AI 网关** —— 部署在 Cloudflare Workers 上的个人 AI 服务路由。一个 API Key 调用多家大模型，后端故障自动切换（failover），调用方全程无感 —— 这就是 **Unstop** 的意义。

```
调用方 (OpenAI SDK)                      Unstop Router (Worker + KV)                 真实大模型服务
────────────────────    ──────▶    ┌─────────────────────────────┐    ──────▶    ┌──────────────────┐
  Bearer sk-uns-xxx                 │ 1. 鉴权（Key 即 KV 主键）    │              │ 后端A  ✗ 超时     │
  model: "my-gpt"                   │ 2. 按 model 名找到后端列表    │    自动切换    │ 后端B  ✓ 200     │
                                   │ 3. 按优先级依次尝试          │    ──────▶    │ 后端C  (备)      │
                                   │ 4. 失败自动切下一个          │               └──────────────────┘
                                   └─────────────────────────────┘
```

## 功能特性

- **🔑 一个 Key，一个入口**：首页生成或输入 API Key，直接进入该 Key 的管理控制台
- **🧩 多模型 × 多协议 × 多后端**：每个 Key 可创建多个逻辑模型；每个模型可按协议（`openai_compatible` / `anthropic_compatible`）配置多组真实服务（Base URL / API Key / 模型名 / 优先级 / 超时）
- **🔁 自动故障切换**：按优先级依次尝试后端，网络错误、超时、`429/5xx/401/403` 自动切到下一个；带进程内熔断冷却，避免反复撞死后端
- **⚡ OpenAI 兼容**：`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/models`，SSE 流式原样透传，现有 SDK 只改 `base_url` 和 `api_key` 即可迁移
- **🧪 连通性测试**：控制台一键对任意后端发起真实小请求，验证配置
- **📊 用量统计**：按天成功/失败计数、平均延迟、最近请求记录（KV 分桶存储）
- **🚀 零数据库运维**：全部状态存 Cloudflare KV，Key 本身就是存储主键，无需建表

## 项目结构

```
usrouter/
├── src/
│   ├── index.ts        # Worker 入口：路由分发（/api、/v1、静态资源）
│   ├── auth.ts         # API Key 鉴权（Key 即 KV 主键）
│   ├── kv.ts           # KV 存储层：配置文档 + 用量统计分桶
│   ├── admin.ts        # 管理 REST API（Key/模型/后端 CRUD、测试、统计）
│   ├── proxy.ts        # 代理核心：故障切换 + 熔断 + 透传
│   ├── protocols.ts    # 协议注册表（路径映射、鉴权方式、连通性测试）
│   ├── types.ts        # 类型定义
│   └── util.ts         # 通用工具
├── public/             # 前端（静态资源，无构建步骤）
│   ├── index.html      # 首页：生成 / 输入 API Key
│   ├── manage.html     # 管理控制台
│   ├── home.js / app.js
│   └── style.css
├── scripts/mock-upstream.mjs  # 本地 Mock 上游（健康/故障/慢速三个端口）
└── wrangler.toml
```

## KV 数据布局

| KV Key | Value | 说明 |
|---|---|---|
| `sk-uns-xxxx...`（Key 本身） | `{name, prefix, created_at, models: {模型名: {created_at, endpoints: [...]}}}` | 该 Key 的全部配置，一次读取即可完成鉴权与路由 |
| `stats:<apikey>:<YYYY-MM-DD>` | `{total, ok, failed, latency_sum, recent[≤50]}` | 按天分桶统计（避免同 key 高频写被 KV 限流） |

> 说明：KV 对同一 Key 的写入约 1 次/秒。代理请求路径只读配置；统计在进程内聚合、每 2 秒批量落盘一次（best-effort）。把 API Key 明文作为 KV 主键意味着拿到 KV 读权限即可看到 Key——KV 仅限你的账号与 Worker 访问，个人自用场景可接受；如需更高安全级别可自行改为存哈希。

## 快速开始（本地开发）

```bash
npm install
npm run mock        # 终端1：Mock 上游 :9091(正常) :9092(故障) :9093(慢)
npm run dev         # 终端2：http://127.0.0.1:8787
```

打开 `http://127.0.0.1:8787` → 生成 API Key → 创建模型（如 `my-gpt`）→ 添加两个后端：
`http://127.0.0.1:9092/v1`（优先级 0，会失败）和 `http://127.0.0.1:9091/v1`（优先级 1），然后：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-uns-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"my-gpt","messages":[{"role":"user","content":"hi"}]}'
# 响应头 x-unstop-attempts: 2 表示自动切换成功
```

## 部署到 Cloudflare

```bash
npx wrangler login                       # 浏览器授权
npx wrangler kv namespace create KV      # 复制输出的 id
# 编辑 wrangler.toml，替换 [[kv_namespaces]] 的 id
npm run deploy                           # 部署
```

部署完成后访问 `https://unstop-router.<你的子域>.workers.dev` 即可使用。

**绑定自定义域名**：在 `wrangler.toml` 的 `routes` 中声明即可（要求域名 zone 已托管在本账号）：

```toml
routes = [
  { pattern = "usrouter.your-domain.com", custom_domain = true }
]
```

部署后 Cloudflare 会自动创建 DNS 记录与证书。示例：`https://usrouter.hw365.top`。

也可推送代码到 GitHub 后，在仓库/Cloudflare 中配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 两个 Secret，由 `.github/workflows/deploy.yml` 自动部署。

## 使用指南

1. **首页** 生成 API Key（只显示一次，保存好）或输入已有 Key → 进入管理页面
2. **创建逻辑模型**：名字即调用方请求里的 `model` 字段（如 `gpt-4o-mini`、`my-claude`）
3. **为模型添加后端**（可多个，按优先级从小到大依次尝试）：
   - 协议：`openai_compatible`（Base URL 以 `/v1` 结尾，如 `https://api.deepseek.com/v1`）或 `anthropic_compatible`（Base URL 不带 `/v1`，如 `https://api.anthropic.com`）
   - 上游 API Key、上游模型名（留空 = 与逻辑模型同名）、优先级、超时
   - 点「测试」验证连通性
4. **调用**：任何 OpenAI 兼容客户端，把 `base_url` 改为 `https://<你的worker>/v1`，`api_key` 改为 `sk-uns-...`

## API 参考

**管理 API**（除创建/校验 Key 外，均需 `X-API-Key: sk-uns-...` 请求头）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/keys` `{name?}` | 生成新 Key（明文仅返回一次） |
| POST | `/api/keys/verify` `{key}` | 校验 Key 是否存在 |
| GET | `/api/bootstrap` | 概览 + 模型/后端 + 统计（控制台数据源） |
| POST | `/api/models` `{name}` | 创建逻辑模型 |
| PUT/DELETE | `/api/models/:name` | 重命名 / 删除（含其全部后端） |
| POST | `/api/models/:name/endpoints` | 添加后端 `{protocol, base_url, api_key?, model?, priority?, enabled?, timeout_ms?}` |
| PUT/DELETE | `/api/endpoints/:id` | 更新 / 删除后端 |
| POST | `/api/endpoints/:id/test` | 连通性测试 |
| GET | `/api/stats` | 用量统计 |

**代理 API**（`Authorization: Bearer sk-uns-...`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 列出该 Key 的逻辑模型 |
| POST | `/v1/chat/completions` | Chat（支持 `stream: true`） |
| POST | `/v1/completions` | 文本补全 |
| POST | `/v1/embeddings` | 向量 |
| POST | `/v1/messages` | Anthropic 协议（走 `anthropic_compatible` 后端） |

响应头 `x-unstop-served-by`（实际服务的后端 ID）、`x-unstop-attempts`（尝试次数）便于排查切换行为。

## 故障切换策略

- 尝试顺序：`priority` 升序（数字小者先），相同则按创建时间
- 触发切换：网络错误、请求超时、上游 `401/403/408/429/5xx`
- 不切换：其余 `4xx`（如 400 参数错误，原样透传给调用方）
- 熔断冷却：失败后按 `30s × 连续失败次数`（封顶 5 分钟）进入冷却，期间优先跳过；所有后端都失败时冷却中的后端仍会作为兜底被重试
- 流式说明：切换发生在响应头返回前；若流式响应已开始输出，后续中断无法重试（HTTP 语义限制）

## 路线图

- [ ] Web 端流式调试台（Playground）
- [ ] 按后端加权分流 / 灰度
- [ ] 生成 Key 增加 Turnstile 防滥用
- [ ] 更多协议：Gemini 原生、Azure OpenAI
- [ ] Key 级限额与到期时间

## License

MIT
