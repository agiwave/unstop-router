'use strict';

const KEY_STORAGE = 'unstop.key';
let KEY = localStorage.getItem(KEY_STORAGE) || '';
let DATA = null; // bootstrap 数据
let editing = null; // { modelId, ep|null }

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await resp.json(); } catch {}
  if (!resp.ok) {
    const msg = data?.error?.message || data?.error || 'HTTP ' + resp.status;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ---------------- 初始化 ---------------- */
async function init() {
  $('#btn-logout').addEventListener('click', () => {
    localStorage.removeItem(KEY_STORAGE);
    location.href = '/';
  });
  $('#btn-copy-base').addEventListener('click', async () => {
    if (!DATA) return;
    try {
      await navigator.clipboard.writeText(DATA.base_url);
      $('#btn-copy-base').textContent = '已复制';
      setTimeout(() => ($('#btn-copy-base').textContent = '复制接入地址'), 1500);
    } catch {}
  });
  $('#btn-gate-enter').addEventListener('click', async () => {
    KEY = $('#gate-key').value.trim();
    const errEl = $('#gate-err');
    errEl.classList.add('hidden');
    if (!KEY) {
      errEl.textContent = '请输入 API Key';
      errEl.classList.remove('hidden');
      return;
    }
    try {
      await api('/api/bootstrap');
      localStorage.setItem(KEY_STORAGE, KEY);
      enterApp();
    } catch (e) {
      errEl.textContent = e.message || '验证失败';
      errEl.classList.remove('hidden');
    }
  });

  bindModelForm();
  bindModelActions();
  bindEndpointDialog();

  if (!KEY) {
    $('#key-gate').classList.remove('hidden');
  } else {
    try {
      await api('/api/bootstrap'); // 校验本地保存的 key
      enterApp();
    } catch {
      localStorage.removeItem(KEY_STORAGE);
      KEY = '';
      $('#key-gate').classList.remove('hidden');
    }
  }
}

function enterApp() {
  $('#key-gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#btn-logout').classList.remove('hidden');
  $('#btn-copy-base').classList.remove('hidden');
  load();
}

async function load() {
  try {
    DATA = await api('/api/bootstrap');
    render();
  } catch (e) {
    alert('加载失败：' + e.message);
  }
}

/* ---------------- 渲染 ---------------- */
function render() {
  const { key, base_url, models, stats, protocols } = DATA;

  $('#key-badge').textContent = `${key.name} · ${key.prefix}`;
  $('#key-badge').classList.remove('hidden');
  document.title = `Unstop Router · ${key.name}`;

  const protoNames = Object.fromEntries(protocols.map((p) => [p.id, p.label]));
  const firstModel = models[0]?.name || '<模型名>';

  $('#overview').innerHTML = `
    <dt>备注名</dt><dd>${esc(key.name)}</dd>
    <dt>Key 前缀</dt><dd class="mono">${esc(key.prefix)}</dd>
    <dt>接入地址</dt><dd class="mono">${esc(base_url)}</dd>
    <dt>累计请求</dt><dd>${key.request_count}</dd>
    <dt>最近使用</dt><dd>${fmtTime(key.last_used_at)}</dd>
    <dt>创建时间</dt><dd>${fmtTime(key.created_at)}</dd>`;

  $('#curl-example').innerHTML =
    `# OpenAI SDK 兼容接入\n` +
    `curl ${esc(base_url)}/chat/completions \\\n` +
    `  -H "Authorization: Bearer ${esc(KEY)}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"${esc(firstModel)}","messages":[{"role":"user","content":"hello"}]}'` +
    `<button class="copy small" id="btn-copy-curl">复制</button>`;
  $('#btn-copy-curl').addEventListener('click', async () => {
    const lines = $('#curl-example').textContent.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    try { await navigator.clipboard.writeText(lines); $('#btn-copy-curl').textContent = '已复制'; } catch {}
  });

  // 用量统计（按天）
  $('#stats-days').innerHTML = `
    <thead><tr><th>日期</th><th>总请求</th><th>成功</th><th>失败</th><th>平均延迟</th></tr></thead>
    <tbody>${stats.days
      .map(
        (d) =>
          `<tr><td class="mono">${esc(d.day)}</td><td>${d.total}</td>` +
          `<td style="color:var(--ok)">${d.ok ?? 0}</td>` +
          `<td style="color:${(d.failed ?? 0) > 0 ? 'var(--err)' : 'inherit'}">${d.failed ?? 0}</td>` +
          `<td>${d.avg_latency_ms ?? '-'} ms</td></tr>`
      )
      .join('') || '<tr><td colspan="5" class="muted">暂无数据，发起一次调用后刷新</td></tr>'}</tbody>`;

  // 最近请求
  $('#stats-recent').innerHTML = `
    <thead><tr><th>时间</th><th>模型</th><th>协议</th><th>结果</th><th>延迟</th></tr></thead>
    <tbody>${stats.recent
      .slice(0, 12)
      .map(
        (r) =>
          `<tr><td class="mono">${fmtTime(r.created_at)}</td><td class="mono">${esc(r.model_name)}</td>` +
          `<td><span class="pill proto">${esc(protoNames[r.protocol] || r.protocol)}</span></td>` +
          `<td>${r.status === 'success' ? '<span class="pill on">成功</span>' : `<span class="pill off" title="${esc(r.error || '')}">失败 ${r.status_code ?? '网络'}</span>`}</td>` +
          `<td>${r.latency_ms ?? '-'} ms${r.stream ? ' ·流式' : ''}</td></tr>`
      )
      .join('') || '<tr><td colspan="5" class="muted">暂无数据</td></tr>'}</tbody>`;

  // 模型列表
  $('#models').innerHTML =
    models
      .map((m) => {
        const eps = m.endpoints || [];
        return `
        <div class="model-card" data-model="${esc(m.id)}">
          <div class="model-head">
            <h3 class="mono">${esc(m.name)}</h3>
            <span class="muted">${eps.length} 个后端</span>
            <span class="spacer"></span>
            <button class="small ghost" data-act="rename" data-model="${esc(m.id)}">重命名</button>
            <button class="small ghost" data-act="add-ep" data-model="${esc(m.id)}">+ 添加后端</button>
            <button class="small danger" data-act="del-model" data-model="${esc(m.id)}">删除模型</button>
          </div>
          ${
            eps.length
              ? `<table><thead><tr><th>协议</th><th>Base URL</th><th>上游模型</th><th>优先级</th><th>超时</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>${eps
                .map(
                  (ep) => `<tr data-ep="${esc(ep.id)}">
                  <td><span class="pill proto">${esc(protoNames[ep.protocol] || ep.protocol)}</span></td>
                  <td class="mono" style="max-width:260px;word-break:break-all">${esc(ep.base_url)}</td>
                  <td class="mono">${esc(ep.model) || '<span class="muted">(同逻辑名)</span>'}</td>
                  <td>${ep.priority}</td>
                  <td>${ep.timeout_ms} ms</td>
                  <td>${ep.enabled ? '<span class="pill on">启用</span>' : '<span class="pill off">停用</span>'}</td>
                  <td><div class="ep-actions">
                    <button class="small" data-act="test" data-ep="${esc(ep.id)}">测试</button>
                    <button class="small ghost" data-act="edit" data-ep="${esc(ep.id)}">编辑</button>
                    <button class="small ghost" data-act="toggle" data-ep="${esc(ep.id)}">${ep.enabled ? '停用' : '启用'}</button>
                    <button class="small danger" data-act="del-ep" data-ep="${esc(ep.id)}">删除</button>
                  </div></td>
                </tr>
                <tr class="test-row" data-test-row="${esc(ep.id)}" style="display:none"><td colspan="7"></td></tr>`
                )
                .join('')}</tbody></table>`
              : '<p class="muted" style="margin:8px 0">尚未配置后端服务 —— 调用该模型会返回 503。点击右上角「+ 添加后端」。</p>'
          }
        </div>`;
      })
      .join('') || '<p class="muted">还没有模型。在上方输入名称创建第一个逻辑模型。</p>';
}

/* ---------------- 交互：模型 ---------------- */
function bindModelForm() {
  $('#btn-add-model').addEventListener('click', async () => {
    const input = $('#new-model-name');
    const name = input.value.trim();
    if (!name) return alert('请输入模型名称');
    try {
      await api('/api/models', { method: 'POST', body: { name } });
      input.value = '';
      await load();
    } catch (e) {
      alert(e.message);
    }
  });
  $('#new-model-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-add-model').click();
  });
}

function bindModelActions() {
  // 事件委托只需绑定一次（#models 容器本身不会被替换，innerHTML 更新后委托依然有效）。
  // 幂等保护：防止重复调用导致监听器累积（此前每次 render() 都调用，导致点击触发多次、功能"失灵"）。
  const container = $('#models');
  if (container.dataset.bound === '1') return;
  container.dataset.bound = '1';
  container.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const modelId = btn.dataset.model;
    const epId = btn.dataset.ep;
    const model = DATA.models.find((m) => m.id === modelId);
    const ep = model?.endpoints?.find((e) => e.id === epId);

    try {
      if (act === 'rename' && model) {
        const name = prompt('新的模型名称', model.name);
        if (!name || name === model.name) return;
        await api('/api/models/' + model.id, { method: 'PUT', body: { name } });
      } else if (act === 'del-model') {
        if (!confirm(`删除模型「${model.name}」及其全部后端配置？`)) return;
        await api('/api/models/' + model.id, { method: 'DELETE' });
      } else if (act === 'add-ep') {
        openEndpointDialog(modelId, null);
        return;
      } else if (act === 'test' && ep) {
        await runTest(ep.id, btn);
        return;
      } else if (act === 'edit' && ep) {
        openEndpointDialog(modelId, ep);
        return;
      } else if (act === 'toggle' && ep) {
        await api('/api/endpoints/' + ep.id, { method: 'PUT', body: { enabled: !ep.enabled } });
      } else if (act === 'del-ep' && ep) {
        if (!confirm('删除该后端服务？')) return;
        await api('/api/endpoints/' + ep.id, { method: 'DELETE' });
      }
      await load();
    } catch (e) {
      alert(e.message);
    }
  });
}

async function runTest(epId, btn) {
  const row = document.querySelector(`tr[data-test-row="${epId}"]`);
  const cell = row?.querySelector('td');
  btn.disabled = true;
  if (row) {
    row.style.display = '';
    cell.innerHTML = '<span class="testline">⏳ 正在向上游发起真实请求（最长 20 秒）…</span>';
  }
  try {
    const r = await api(`/api/endpoints/${epId}/test`, { method: 'POST' });
    if (r.ok) {
      cell.innerHTML = `<span class="testline ok">✓ 连通正常 · HTTP ${r.status_code} · ${r.latency_ms} ms · 样例: ${esc(r.sample || '(空)')}</span>`;
    } else {
      cell.innerHTML = `<span class="testline bad">✗ 失败 · ${r.status_code ? 'HTTP ' + r.status_code : '网络错误'} · ${r.latency_ms} ms<br>${esc(r.error || '')}</span>`;
    }
  } catch (e) {
    cell.innerHTML = `<span class="testline bad">✗ ${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 交互：后端服务弹窗 ---------------- */
function bindEndpointDialog() {
  const dialog = $('#ep-dialog');

  $('#f-protocol').addEventListener('change', () => {
    const p = DATA.protocols.find((x) => x.id === $('#f-protocol').value);
    $('#f-protocol-hint').textContent = p ? p.description : '';
    if (p) $('#f-base').placeholder = p.base_url_placeholder;
  });

  $('#btn-ep-cancel').addEventListener('click', () => dialog.close());
  $('#btn-ep-save').addEventListener('click', async () => {
    const body = {
      protocol: $('#f-protocol').value,
      base_url: $('#f-base').value.trim(),
      api_key: $('#f-apikey').value.trim(),
      model: $('#f-model').value.trim(),
      priority: Number($('#f-priority').value || 0),
      timeout_ms: Number($('#f-timeout').value || 120000),
      enabled: $('#f-enabled').value === '1',
    };
    $('#f-err').classList.add('hidden');
    try {
      if (editing.ep) {
        await api('/api/endpoints/' + editing.ep.id, { method: 'PUT', body });
      } else {
        await api(`/api/models/${editing.modelId}/endpoints`, { method: 'POST', body });
      }
      dialog.close();
      await load();
    } catch (e) {
      $('#f-err').textContent = e.message;
      $('#f-err').classList.remove('hidden');
    }
  });
}

function openEndpointDialog(modelId, ep) {
  editing = { modelId, ep };
  const dialog = $('#ep-dialog');
  $('#ep-title').textContent = ep ? '编辑后端服务' : '添加后端服务';
  $('#f-err').classList.add('hidden');

  const sel = $('#f-protocol');
  sel.innerHTML = DATA.protocols
    .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}（${esc(p.id)}）</option>`)
    .join('');

  $('#f-base').value = ep?.base_url || '';
  $('#f-apikey').value = ep?.api_key || '';
  $('#f-model').value = ep?.model || '';
  $('#f-priority').value = ep?.priority ?? 0;
  $('#f-timeout').value = ep?.timeout_ms ?? 120000;
  $('#f-enabled').value = ep ? String(ep.enabled ? '1' : '0') : '1';

  if (ep) sel.value = ep.protocol;
  sel.dispatchEvent(new Event('change'));
  if (ep) $('#f-protocol-hint').textContent = DATA.protocols.find((p) => p.id === ep.protocol)?.description || '';

  dialog.showModal();
}

init();
