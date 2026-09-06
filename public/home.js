'use strict';

const $ = (s) => document.querySelector(s);
const KEY_STORAGE = 'unstop.key';

// Tab 切换
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-new').classList.toggle('hidden', btn.dataset.tab !== 'new');
    $('#tab-exist').classList.toggle('hidden', btn.dataset.tab !== 'exist');
  });
});

// 生成新 Key
$('#btn-generate').addEventListener('click', async () => {
  const btn = $('#btn-generate');
  const name = $('#new-name').value.trim();
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const resp = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || '创建失败');
    localStorage.setItem(KEY_STORAGE, data.key);
    $('#new-key').textContent = data.key;
    $('#new-result').classList.remove('hidden');
    btn.textContent = '✓ 已生成';
  } catch (e) {
    alert(e.message || '创建失败');
    btn.disabled = false;
    btn.textContent = '生成 API Key';
  }
});

$('#btn-copy-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#new-key').textContent);
    $('#btn-copy-key').textContent = '已复制';
  } catch {
    // 某些环境不支持 clipboard API，退化为选中
    const range = document.createRange();
    range.selectNodeContents($('#new-key'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    $('#btn-copy-key').textContent = '请 Ctrl+C';
  }
});

$('#btn-enter').addEventListener('click', () => {
  location.href = '/manage';
});

// 校验已有 Key
$('#btn-verify').addEventListener('click', async () => {
  const key = $('#exist-key').value.trim();
  const errEl = $('#exist-err');
  errEl.classList.add('hidden');
  if (!key) {
    errEl.textContent = '请输入 API Key';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const resp = await fetch('/api/keys/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data?.error || 'API Key 不存在');
    localStorage.setItem(KEY_STORAGE, key);
    location.href = '/manage';
  } catch (e) {
    errEl.textContent = e.message || '验证失败';
    errEl.classList.remove('hidden');
  }
});
