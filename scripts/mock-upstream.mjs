#!/usr/bin/env node
/**
 * 本地开发用的 Mock 上游大模型服务：
 *   :9091  健康（返回正常 chat completion，支持 stream）
 *   :9092  故障（始终返回 503）
 *   :9093  慢（延迟 3 秒后返回 500，用于测试超时/切换）
 *
 * 用法: node scripts/mock-upstream.mjs
 * 用途: 本地验证 Unstop Router 的故障切换逻辑
 */
import http from 'node:http';

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function chatHandler(label) {
  return async (req, res) => {
    const raw = await readBody(req);
    let parsed = {};
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {}
    if (!parsed.model) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model is required' } }));
      return;
    }
    if (parsed.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (delta) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          model: parsed.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant' }));
      for (const tok of ['Hello', ' from', ' mock', ' upstream', ` ${label}`]) {
        res.write(chunk({ content: tok }));
        await new Promise((r) => setTimeout(r, 30));
      }
      res.write(chunk({}));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: parsed.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `Hello from mock upstream ${label}` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
      })
    );
  };
}

const healthy = http.createServer(chatHandler('(:9091)'));
const failing = http.createServer((req, res) => {
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'mock upstream is down (:9092)', type: 'mock_error' } }));
});
const slow = http.createServer(async (req, res) => {
  await new Promise((r) => setTimeout(r, 3000));
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'mock upstream too slow (:9093)', type: 'mock_error' } }));
});

healthy.listen(9091, () => console.log('mock healthy upstream : http://127.0.0.1:9091/v1  (works)'));
failing.listen(9092, () => console.log('mock failing upstream : http://127.0.0.1:9092/v1  (always 503)'));
slow.listen(9093, () => console.log('mock slow upstream    : http://127.0.0.1:9093/v1  (3s then 500)'));
