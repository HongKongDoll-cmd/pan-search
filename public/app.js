const PAN_LABEL = {
  pan123: '123云盘', quark: '夸克网盘', aliyun: '阿里云盘', baidu: '百度网盘',
  tianyi: '天翼云盘', xunlei: '迅雷云盘', yun139: '移动云盘', '115': '115网盘',
  weiyun: '微云', lanzou: '蓝奏云', uc: 'UC网盘', pikpak: 'PikPak', magnet: '磁力链接', other: '其他',
};
const ENGINE_LABEL = { pansearch: '聚合库', ddg: 'DuckDuckGo', bing: 'Bing' };
const PLATFORMS = [
  ['all', '全部'], ['pan123', '123云盘'], ['quark', '夸克网盘'], ['aliyun', '阿里云盘'],
  ['baidu', '百度网盘'], ['tianyi', '天翼云盘'], ['xunlei', '迅雷云盘'], ['uc', 'UC网盘'], ['pikpak', 'PikPak'],
];

let platform = localStorage.getItem('ps-platform') || 'all';
let lastResults = [];

const $kw = document.getElementById('kw');
const $go = document.getElementById('go');
const $chips = document.getElementById('chips');
const $status = document.getElementById('status');
const $list = document.getElementById('list');
const $empty = document.getElementById('empty');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 平台切换 ---------- */
function renderChips() {
  $chips.innerHTML = PLATFORMS.map(([id, label]) =>
    `<button class="chip${id === platform ? ' active' : ''}" data-p="${id}">${label}</button>`).join('');
}
$chips.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  platform = btn.dataset.p;
  localStorage.setItem('ps-platform', platform);
  renderChips();
  const kw = $kw.value.trim();
  if (kw) doSearch(kw);
});

/* ---------- 搜索 ---------- */
function search(force) {
  const kw = $kw.value.trim();
  if (!kw) return;
  saveHistory(kw);
  doSearch(kw, force);
}
$go.addEventListener('click', () => search(false));
document.getElementById('go2').addEventListener('click', () => search(true));
$kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(false); });

async function doSearch(kw, force) {
  $empty.style.display = 'none';
  $list.innerHTML = '';
  $status.innerHTML = '<span class="spin"></span> ' + (force ? '强制刷新中' : '正在搜索') + '「' + esc(kw) + '」…（多数据源并发，请稍候）';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(kw) + '&platform=' + platform + (force ? '&force=1' : ''));
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);

    const engHtml = (data.engines || []).map((e) => e.ok
      ? `<span class="eng ok">${esc(ENGINE_LABEL[e.id] || e.id)} ${e.count} 条</span>`
      : `<span class="eng bad" title="${esc(e.error || '')}">${esc(ENGINE_LABEL[e.id] || e.id)} 失败</span>`
    ).join('');
    $status.innerHTML = `共 <b>${data.total}</b> 条结果 <span class="engs">${engHtml}</span>`;

    if (!data.results.length) {
      $list.innerHTML = '<div class="empty">没有找到相关资源，换个关键词试试（资源名越短越好）<br>也可以点上方「强制刷新」重新搜索一轮 — 部分数据源的结果有延迟，晚到会更多</div>';
      return;
    }
    lastResults = data.results;
    $list.innerHTML = data.results.map(cardHTML).join('');
  } catch (err) {
    $status.innerHTML = '<span class="err">搜索失败：' + esc(err.message) + '</span>';
  }
}

function cardHTML(r, i) {
  const label = PAN_LABEL[r.panType] || '其他';
  return `<div class="card">
    <a class="title" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
    <div class="meta">
      <span class="badge t-${esc(r.panType)}">${label}</span>
      <span class="host">${esc(r.host)}</span>
      <span class="src">via ${esc(r.engine)}</span>
      ${r.code ? `<span class="code">提取码 ${esc(r.code)}</span>` : ''}
    </div>
    ${r.snippet ? `<p class="snippet">${esc(r.snippet)}</p>` : ''}
    <div class="ops">
      <button data-act="link" data-idx="${i}">复制链接</button>
      ${r.code ? `<button data-act="code" data-idx="${i}">复制提取码</button>` : ''}
    </div>
  </div>`;
}

/* ---------- 复制操作（事件委托） ---------- */
$list.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const r = lastResults[+btn.dataset.idx];
  if (!r) return;
  if (btn.dataset.act === 'link') copyText(r.url, '链接已复制');
  if (btn.dataset.act === 'code') copyText(r.code, '提取码已复制');
});

function copyText(text, msg) {
  const done = () => toast(msg);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { /* 忽略 */ }
  ta.remove();
}

let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

/* ---------- 搜索历史 ---------- */
function saveHistory(kw) {
  let h = [];
  try { h = JSON.parse(localStorage.getItem('ps-history') || '[]'); } catch { /* 忽略 */ }
  h = [kw, ...h.filter((x) => x !== kw)].slice(0, 8);
  localStorage.setItem('ps-history', JSON.stringify(h));
  renderHistory();
}
function renderHistory() {
  let h = [];
  try { h = JSON.parse(localStorage.getItem('ps-history') || '[]'); } catch { /* 忽略 */ }
  document.getElementById('history').innerHTML = h.map((k) => `<option value="${esc(k)}">`).join('');
}

renderChips();
renderHistory();
