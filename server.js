/**
 * 网盘搜 — 本地网盘资源聚合搜索
 * 引擎：聚合库 API（主）+ DuckDuckGo / Bing（辅助深挖）
 * 自动识别网盘类型与提取码，带结果缓存与频控重试
 */
const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3210;
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
const UA = () => UAS[Math.floor(Math.random() * UAS.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLATFORMS = {
  all:    { label: '全部' },
  pan123: { label: '123云盘', domains: ['123pan.com', '123pan.cn', '123684.com', '123865.com', '123912.com', '123952.com', '123948.com'] },
  quark:  { label: '夸克网盘', domains: ['pan.quark.cn'] },
  aliyun: { label: '阿里云盘', domains: ['alipan.com', 'aliyundrive.com'] },
  baidu:  { label: '百度网盘', domains: ['pan.baidu.com'] },
  tianyi: { label: '天翼云盘', domains: ['cloud.189.cn'] },
  xunlei: { label: '迅雷云盘', domains: ['pan.xunlei.com'] },
  uc:     { label: 'UC网盘', domains: ['drive.uc.cn'] },
  pikpak: { label: 'PikPak', domains: ['mypikpak.com'] },
};

/* ---------- 工具函数 ---------- */
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
function matchDomain(host, domain) { return host === domain || host.endsWith('.' + domain); }

const PAN_TYPE_TABLE = {
  pan123: ['123pan.com', '123pan.cn', '123684.com', '123865.com', '123912.com', '123952.com', '123948.com'],
  quark: ['pan.quark.cn'],
  aliyun: ['alipan.com', 'aliyundrive.com'],
  baidu: ['pan.baidu.com'],
  tianyi: ['cloud.189.cn'],
  xunlei: ['pan.xunlei.com'],
  uc: ['drive.uc.cn'],
  pikpak: ['mypikpak.com'],
  yun139: ['caiyun.139.com'],
  '115': ['115.com', '115cdn.com'],
  weiyun: ['weiyun.com'],
};

function detectPanType(url) {
  if (/^magnet:\?/i.test(url)) return 'magnet';
  const host = hostOf(url);
  if (!host) return null;
  if (host.includes('lanzou')) return 'lanzou';
  for (const [type, domains] of Object.entries(PAN_TYPE_TABLE)) {
    if (domains.some((d) => matchDomain(host, d))) return type;
  }
  return null;
}

/** 解开 Bing 的 /ck/a 跳转包装 */
function unwrapBing(link) {
  try {
    const u = new URL(link, 'https://cn.bing.com');
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const enc = u.searchParams.get('u') || '';
      let b64 = enc.replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const dec = Buffer.from(b64, 'base64').toString('utf8');
      return /^https?:\/\//.test(dec) ? dec : '';
    }
    return u.href;
  } catch { return ''; }
}

async function fetchText(url, { timeout = 9000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA(),
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

/** 从标题/摘要/链接中提取提取码 */
function extractCode(text, url) {
  const pool = `${url} ${text}`;
  let m = pool.match(/(?:提取码|访问码|密码)[\s:：]*([a-zA-Z0-9]{4})(?![a-zA-Z0-9])/);
  if (!m) m = url.match(/[?&](?:pwd|code|password|extcode)=([a-zA-Z0-9]{4,})/i);
  return m ? m[1] : '';
}

/** 去重键：主机 + 路径 + 关键参数（磁力按 btih 哈希） */
function normKey(url) {
  const magnet = url.match(/btih:([a-zA-Z0-9]+)/i);
  if (magnet) return 'magnet:' + magnet[1].toLowerCase();
  try {
    const u = new URL(url);
    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (['pwd', 'surl', 'code', 'password', 'extcode'].includes(k.toLowerCase())) {
        keep.push(k.toLowerCase() + '=' + v);
      }
    }
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (keep.length ? '?' + keep.sort().join('&') : '');
  } catch { return url; }
}

/** 从文本中挖出网盘直链（博客正文里常贴分享链接） */
function extractPanUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>()[\]{}，。；！？“”‘’]+/g;
  let m;
  while ((m = re.exec(text))) {
    const u = m[0].replace(/[.,;:）】]+$/, '');
    if (detectPanType(u)) out.push(u);
  }
  return out;
}

/* ---------- 引擎 1：聚合库（主引擎） ---------- */
async function panSearchOnce(kw, refresh) {
  const url = 'https://so.252035.xyz/api/search?kw=' + encodeURIComponent(kw)
    + '&res=merge&src=all' + (refresh ? '&refresh=true' : '');
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const t = await fetchText(url, { timeout: 25000, headers: { Accept: 'application/json' } });
      if (!t.trim().startsWith('{')) throw new Error('返回异常（疑似频控）');
      const j = JSON.parse(t);
      const merged = j.data && j.data.merged_by_type;
      if (!merged) throw new Error('数据结构变更');
      const out = [];
      for (const [ty, arr] of Object.entries(merged)) {
        const panType = ty === '123' ? 'pan123' : ty;
        for (const it of arr || []) {
          if (!it.url) continue;
          const date = (it.datetime || '').startsWith('20') ? ' · ' + it.datetime.slice(0, 10) : '';
          out.push({
            title: (it.note || '未命名资源').slice(0, 150),
            url: it.url,
            snippet: it.source ? `来源 ${it.source}${date}` : date.trim(),
            code: (it.password || '').trim(),
            panType,
            engine: 'pansearch',
          });
        }
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (i < 1) await sleep(1200);
    }
  }
  throw lastErr;
}

async function searchPanSearch(kw, { refresh = false } = {}) {
  const first = await panSearchOnce(kw, refresh);
  // 二段式：PanSou 插件为"尽快响应、持续处理"模式，部分结果晚到后存入其缓存。
  // 结果较少时停 3.5s 再取一次（第二次命中其磁盘缓存，很快），把迟到结果捞回来。
  if (first.length < 25) {
    await sleep(3500);
    try {
      const second = await panSearchOnce(kw, false);
      return [...first, ...second];
    } catch { return first; }
  }
  return first;
}

/* ---------- 引擎 2：DuckDuckGo ---------- */
function parseDdgHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a.result__a').each((_, el) => {
    const title = $(el).text().trim();
    let href = $(el).attr('href') || '';
    if (href.includes('uddg=')) {
      const m = href.match(/uddg=([^&]+)/);
      if (m) href = decodeURIComponent(m[1]);
    }
    if (!title || !/^https?:\/\//.test(href)) return;
    const snippet = ($(el).closest('.result').find('.result__snippet').first().text() || '').trim();
    out.push({ title, url: href, snippet: snippet.slice(0, 300), engine: 'ddg' });
  });
  return out;
}

function parseDdgLite(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a.result-link').each((_, el) => {
    const title = $(el).text().trim();
    let href = $(el).attr('href') || '';
    if (href.includes('uddg=')) {
      const m = href.match(/uddg=([^&]+)/);
      if (m) href = decodeURIComponent(m[1]);
    }
    if (!title || !/^https?:\/\//.test(href)) return;
    const snippet = ($(el).closest('tr').next('tr').find('td.result-snippet').first().text() || '').trim();
    out.push({ title, url: href, snippet: snippet.slice(0, 300), engine: 'ddg' });
  });
  return out;
}

async function searchDdg(q) {
  const enc = encodeURIComponent(q);
  // html → lite → 停 4s 再 html，共 3 次尝试，缓解突发频控
  const endpoints = [
    { url: 'https://html.duckduckgo.com/html/?q=' + enc, parse: parseDdgHtml, wait: 1800 },
    { url: 'https://lite.duckduckgo.com/lite/?q=' + enc, parse: parseDdgLite, wait: 4000 },
    { url: 'https://html.duckduckgo.com/html/?q=' + enc, parse: parseDdgHtml, wait: 0 },
  ];
  let lastErr;
  for (let i = 0; i < endpoints.length; i++) {
    try {
      const html = await fetchText(endpoints[i].url);
      if (/anomaly|challenge|captcha/i.test(html.slice(0, 3000))) throw new Error('频控验证');
      const out = endpoints[i].parse(html);
      if (!out.length) throw new Error('无结果或被反爬拦截');
      return out;
    } catch (e) {
      lastErr = e;
      if (endpoints[i].wait) await sleep(endpoints[i].wait);
    }
  }
  throw lastErr;
}

/* ---------- 引擎 3：Bing ---------- */
function buildQuery(keyword, platform) {
  if (platform === 'all') return `${keyword} 网盘 提取码`;
  return PLATFORMS[platform].domains.map((d) => `site:${d}`).join(' OR ') + ` ${keyword}`;
}

async function searchBing(q) {
  const html = await fetchText('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&mkt=zh-CN&count=20');
  const $ = cheerio.load(html);
  const out = [];
  $('li.b_algo').each((_, el) => {
    const a = $(el).find('h2 a').first();
    const title = a.text().trim();
    const raw = a.attr('href') || '';
    if (!title || !raw) return;
    const link = unwrapBing(raw);
    if (!/^https?:\/\//.test(link)) return;
    const snippet = ($(el).find('.b_caption p').first().text() || $(el).find('p').first().text() || '').trim();
    out.push({ title, url: link, snippet: snippet.slice(0, 300), engine: 'bing' });
  });
  if (!out.length) throw new Error('无结果或被反爬拦截');
  return out;
}

/* ---------- 结果缓存 ---------- */
const cache = new Map(); // key: platform|kw -> {t, data}
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 80;

/* ---------- 路由 ---------- */
app.get('/api/search', async (req, res) => {
  const keyword = String(req.query.q || '').trim();
  const platform = String(req.query.platform || 'all');
  const force = String(req.query.force || '') === '1';
  if (!keyword) return res.status(400).json({ error: '缺少关键词' });
  if (!PLATFORMS[platform]) return res.status(400).json({ error: '未知平台: ' + platform });

  const cacheKey = platform + '|' + keyword;
  if (!force) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.t < CACHE_TTL) {
      return res.json({ ...hit.data, cached: true });
    }
  }

  const engines = [
    { id: 'pansearch', run: () => searchPanSearch(keyword, { refresh: force }) },
    { id: 'ddg', run: () => searchDdg(buildQuery(keyword, platform)) },
    { id: 'bing', run: () => searchBing(buildQuery(keyword, platform)) },
  ];
  const settled = await Promise.allSettled(engines.map((e) => e.run()));

  let raw = [];
  const engineStatus = engines.map((e, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') { raw.push(...s.value); return { id: e.id, ok: true, count: s.value.length }; }
    return { id: e.id, ok: false, count: 0, error: String((s.reason && s.reason.message) || s.reason) };
  });

  // 从标题/摘要中挖网盘直链（仅搜索引擎类结果）
  for (const r of raw.slice()) {
    if (r.engine === 'pansearch') continue;
    for (const u of extractPanUrls(`${r.title} ${r.snippet}`)) {
      raw.push({ title: r.title, url: u, snippet: '（从搜索摘要中提取的分享链接）', engine: r.engine });
    }
  }

  // 打标 / 过滤 / 去重
  const seen = new Map();      // 完整键 -> 结果
  const bareSeen = new Map();  // 主机+路径键 -> results 下标
  const bareKeyOf = (url) => {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
    } catch { return url; }
  };
  const results = [];
  for (const r of raw) {
    if (!r.url) continue;
    if (!/^https?:\/\//.test(r.url) && !/^magnet:\?/i.test(r.url)) continue;
    const panType = r.panType || detectPanType(r.url);
    if (!panType) continue; // 只要网盘/磁力链接
    if (platform !== 'all' && panType !== platform) continue;
    // 过滤官网普通页面：非聚合库来源必须长得像分享链接（/s/ /t/ /share/ 等路径）
    if (!/^magnet:/i.test(r.url) && r.engine !== 'pansearch') {
      let p = '';
      try { p = new URL(r.url).pathname.toLowerCase(); } catch { /* 忽略 */ }
      if (!/\/(s|t|share|file|toapp)\//.test(p)) continue;
    }
    const key = normKey(r.url);
    let target = seen.get(key);
    if (!target) {
      const bi = bareSeen.get(bareKeyOf(r.url));
      if (bi !== undefined) target = results[bi];
    }
    // 同链去重：优先保留带提取码、标题更长的版本
    if (target) {
      if (!target.code && r.code) { target.code = r.code; target.url = r.url; }
      if ((r.title || '').length > (target.title || '').length) { target.title = r.title; }
      continue;
    }
    const item = {
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      host: hostOf(r.url) || 'magnet',
      panType,
      engine: r.engine,
      code: r.code || extractCode(r.snippet || '', r.url),
    };
    seen.set(key, item);
    if (!/^magnet:/i.test(r.url)) bareSeen.set(bareKeyOf(r.url), results.length);
    results.push(item);
  }

  const EP = { pansearch: 2, ddg: 1, bing: 0.5 };
  const score = (r) => {
    let s = EP[r.engine] || 0;
    if (r.panType === platform) s += 4;
    if (r.panType === 'pan123') s += 1; // 主用平台小加权
    if (r.code) s += 2;
    if (r.panType !== 'magnet') s += 1; // 网盘直链优先于磁力
    return s;
  };
  results.sort((a, b) => score(b) - score(a));

  const data = { query: keyword, platform, total: results.length, engines: engineStatus, results: results.slice(0, 60) };
  cache.set(cacheKey, { t: Date.now(), data });
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  res.json(data);
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`✅ 网盘搜已启动: http://localhost:${PORT}`));
