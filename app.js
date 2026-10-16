// Paper Tracker — 前端逻辑
// 数据库加载:多源候选(OSS → 同源 gz → 备用线路),流式下载 + DecompressionStream 解压;
// Service Worker 负责壳与数据库缓存(sw.js);筛选状态同步到 URL query。

// ===== 配置 =====
// 阿里云 OSS 主数据源(配置后填入,如:
//   https://paper-tracker-data.oss-cn-hangzhou.aliyuncs.com/rss_state/rss_state.db.gz
// 留空时自动跳过该候选,顺序使用下方回退源)
const OSS_DB_URL = '';
const FALLBACK_DB_URL = 'https://paper.huifeng.he.cn/data/rss_state.db.gz';

let db, SQL;
let PAGE = 1, PAGE_SIZE = 30;
let TOTAL_PAGES = 1;

const state = {
  bilingual: false,
  sort: 'date-desc',
  expandAll: localStorage.getItem('pt_expand_abs') === '1',
};
let restoringFromPop = false; // popstate 恢复期间抑制 URL 回写

// 类型归一化:同一含义的变体在下拉中合并显示,筛选时展开为 IN 查询
const TYPE_CANON = {
  'News And Views': 'News & Views',
  'Research Briefings': 'Research Briefing',
};

// ===== 双语按钮 =====
function updateBilingualButton() {
  const biBtn = document.getElementById('bilingual-toggle-float');
  if (biBtn) {
    const span = biBtn.querySelector('span');
    if (span) span.textContent = '双语：' + (state.bilingual ? '开' : '关');
    biBtn.setAttribute('aria-pressed', String(state.bilingual));
    biBtn.classList.toggle('is-active', state.bilingual);
  }
}

// ===== 自包含 sql.js 加载 =====
function locateFile(file) { return './' + file; }
async function ensureSqlJs() {
  if (typeof initSqlJs === 'function') return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('fallback CDN sql.js 加载失败'));
    document.head.appendChild(s);
  });
  if (typeof initSqlJs !== 'function') {
    throw new Error('initSqlJs 未定义，请确认 sql-wasm.js/sql-wasm.wasm 放在站点根目录或网络可达');
  }
}

// ===== 访问统计(服务端) =====
const _M = 'https://paper.huifeng.he.cn/api/metrics';

function getUvId() {
  const LS = window.localStorage;
  const KEY = 'uv_id';
  let id = LS.getItem(KEY);
  if (!id) {
    id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    LS.setItem(KEY, id);
  }
  return id;
}

function _post(url, obj) {
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

function trackClick(action) {
  _post(`${_M}/click`, { a: action });
}

function trackVisits() {
  _post(`${_M}/visit`, { uv_id: getUvId() });
  fetchSiteStats();
}

async function fetchSiteStats() {
  const bar = document.getElementById('site-stats');
  if (!bar) return;
  try {
    const res = await fetch(`${_M}/stats`, { signal: AbortSignal.timeout(3000) });
    const d = await res.json();
    const parts = [`浏览 ${d.pv || 0}`, `访客 ${d.uv || 0}`];
    const acts = Object.entries(d.actions || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`);
    if (acts.length) parts.push(acts.join(' · '));
    bar.textContent = parts.join(' · ');
  } catch (_) {
    bar.textContent = '统计服务暂不可用';
  }
}
window.trackVisits = trackVisits;

// ===== 工具函数 =====
function fmtDate(s){ if(!s) return ''; const m = /^(\d{4}-\d{2}-\d{2})/.exec(s); return m? m[1] : s; }
function escapeHtml(str){ return (str||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])) }
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlightAndEscape(text, kw){
  const s = String(text || '');
  const q = String(kw || '').trim();
  if (!q) return escapeHtml(s);
  // 与搜索 WHERE 一致:逗号或空白都作为分隔,每个词独立高亮
  const terms = q.split(/[,\s]+/).filter(Boolean);
  if (!terms.length) return escapeHtml(s);
  const pattern = terms.map(escapeRegExp).join('|');
  const re = new RegExp(`(${pattern})`, 'gi');
  const marked = s.replace(re, '[[[H]]]' + '$1' + '[[[/H]]]');
  let esc = escapeHtml(marked);
  esc = esc.replace(/\[\[\[H\]\]\]/g, '<mark>').replace(/\[\[\[\/H\]\]\]/g, '</mark>');
  return esc;
}

function query(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function hashHsl(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 55 + (h % 20);
  const light = 46 + (h % 10);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function lightenHsl(hslStr, delta = 18) {
  const m = /hsl\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)/i.exec(hslStr);
  if (!m) return hslStr;
  const hue = Number(m[1]);
  const sat = Number(m[2]);
  const light = Number(m[3]);
  const nl = Math.min(95, Math.max(0, Math.round(light + delta)));
  return `hsl(${hue} ${sat}% ${nl}%)`;
}

function getTagColors(tag) {
  const PRESET = {
    '生命科学': 'hsl(142 71% 45%)',
    '人工智能': 'hsl(246 71% 52%)',
    '3D打印和增材制造': 'hsl(24 90% 50%)',
    '其他': 'hsl(220 14% 46%)',
  };
  const active = PRESET[tag] || hashHsl(tag);
  const inactive = lightenHsl(active, 50);
  return { active, inactive };
}
function parseTags(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
    try {
      const parsed = JSON.parse(s);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return Array.from(new Set(arr.map(x => String(x).trim()).filter(Boolean)));
    } catch (_) { /* 退回到普通切分 */ }
  }
  return Array.from(
    new Set(
      s
        .split(/[,;｜|，；/]+|\s+/g)
        .map(t => t.replace(/^"+|"+$/g, '').trim())
        .filter(Boolean)
    )
  );
}
function todayStr(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}
function fmtLocalDateTime(input){
  if (!input) return '';
  let d;
  if (/^\d{13}$/.test(String(input))) {
    d = new Date(Number(input));
  } else if (/^\d{10}$/.test(String(input))) {
    d = new Date(Number(input) * 1000);
  } else {
    d = new Date(String(input));
  }
  if (isNaN(d)) return String(input);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const da = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${y}-${m}-${da} ${hh}:${mm}`;
}

// 库信息 + 「今日更新 N 篇」角标
function renderLastUpdated(){
  try{
    const row = query(`SELECT COUNT(*) AS n, MAX(last_updated_at) AS ts FROM articles`)[0];
    const today = query(
      `SELECT COUNT(*) AS n FROM articles WHERE substr(last_updated_at,1,10) = :today`,
      { ':today': todayStr() }
    )[0];
    const el = document.getElementById('db-updated');
    if (el && row) {
      const todayN = today ? Number(today.n) : 0;
      el.innerHTML =
        `数据库共 ${row.n} 条 · 最近更新：${escapeHtml(fmtLocalDateTime(row.ts))}` +
        (todayN > 0 ? ` <span class="today-badge">今日 +${todayN}</span>` : '');
    }
  }catch(e){
    console.warn('获取最近更新时间失败：', e);
  }
}

// ===== 数字动画 =====
function animateCount(el, target) {
  const duration = 300;
  const start = performance.now();
  const from = parseInt(el.textContent.replace(/\D/g, '')) || 0;
  if (from === target) { el.textContent = `共 ${target} 条`; return; }
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - (1 - progress) * (1 - progress);
    const current = Math.round(from + (target - from) * eased);
    el.textContent = `共 ${current} 条`;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ===== 数据库加载管线 =====
function buildCandidates() {
  const cands = [];
  if (OSS_DB_URL) {
    cands.push({ url: OSS_DB_URL, label: '阿里云 OSS', ttfb: 5000, stall: 20000, hard: 90000 });
  }
  cands.push({
    url: new URL('./data/rss_state.db.gz', location.href).href,
    label: '同源镜像', ttfb: 4000, stall: 20000, hard: 60000,
  });
  cands.push({
    url: FALLBACK_DB_URL,
    label: '备用线路', ttfb: 8000, stall: 30000, hard: 120000,
  });
  // 老浏览器(无 DecompressionStream):追加未压缩同源文件(仅自建部署存在)
  if (!('DecompressionStream' in window)) {
    cands.push({
      url: new URL('./data/rss_state.db', location.href).href,
      label: '同源(未压缩)', ttfb: 8000, stall: 30000, hard: 150000,
    });
  }
  return cands;
}

function summarizeErr(err) {
  const reason = String(err && err.message || err || '');
  if (/ttfb/i.test(reason)) return '响应超时';
  if (/stall/i.test(reason)) return '传输中断';
  if (/hard/i.test(reason)) return '总超时';
  if (/HTTP \d+/.test(reason)) return reason;
  if (/Failed to fetch|NetworkError|CORS/i.test(reason)) return '网络不可达';
  return reason || '未知错误';
}

async function loadDb(onProgress) {
  const attempts = [];
  for (const c of buildCandidates()) {
    try {
      const buf = await fetchDbWithProgress(c, onProgress);
      console.info(`[db] loaded from ${c.label} (${buf.length} bytes)`);
      return buf;
    } catch (err) {
      attempts.push({ label: c.label, err: summarizeErr(err) });
      console.warn(`[db] ${c.label} failed:`, err);
    }
  }
  const e = new Error('所有数据源均失败');
  e.attempts = attempts;
  throw e;
}

function makeCounter(onBytes) {
  return new TransformStream({
    transform(chunk, ctrl) { onBytes(chunk.length); ctrl.enqueue(chunk); },
  });
}

// 把魔数嗅探时读走的首块拼回流头
function prependChunk(firstChunk, body) {
  return new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(firstChunk);
      const r = body.getReader();
      try {
        while (true) {
          const { done, value } = await r.read();
          if (done) break;
          ctrl.enqueue(value);
        }
        ctrl.close();
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
}

async function fetchDbWithProgress(cand, onProgress) {
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort('ttfb'), cand.ttfb);
  const hardTimer = setTimeout(() => ac.abort('hard'), cand.hard);
  const armStall = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort('stall'), cand.stall);
  };

  let res;
  try {
    res = await fetch(cand.url, { signal: ac.signal, cache: 'no-cache' });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    clearTimeout(hardTimer);
    ac.abort(); // 释放连接,不读 body
    throw new Error(`HTTP ${res.status}`);
  }

  const total = parseInt(res.headers.get('Content-Length') || '', 10) || 0;
  let received = 0;
  const headReader = res.body.getReader();
  const head = await headReader.read();
  headReader.releaseLock(); // 解锁,让 prependChunk 能重新 getReader
  if (head.done || !head.value || !head.value.length) throw new Error('空响应');
  // 魔数嗅探:是 gzip 才解压;对「服务器已透明解压/未压缩源」免疫
  const isGz = head.value[0] === 0x1f && head.value[1] === 0x8b;

  let stream = prependChunk(head.value, res.body).pipeThrough(
    makeCounter((n) => { armStall(); received += n; onProgress(received, total); })
  );
  if (isGz) {
    if (!('DecompressionStream' in window)) throw new Error('浏览器不支持 gzip 解压');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  try {
    return await readAllIntoGrowingBuffer(stream.getReader());
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(timer);
  }
}

// 预扩容缓冲:16MB 起步 ×1.6 增长,避免 chunks 数组 + 二次拼接拷贝
async function readAllIntoGrowingBuffer(reader) {
  let cap = 16 << 20, len = 0;
  let buf = new Uint8Array(cap);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (len + value.length > cap) {
      while (len + value.length > cap) cap = Math.ceil(cap * 1.6);
      const nb = new Uint8Array(cap);
      nb.set(buf.subarray(0, len));
      buf = nb;
    }
    buf.set(value, len);
    len += value.length;
  }
  return buf.subarray(0, len);
}

// 等待 SW 接管(上限 1.2s):让首次访问的 db 下载也流经 SW 入缓存
function waitSwControlOrTimeout(ms) {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    }
    navigator.serviceWorker.addEventListener('controllerchange', done);
  });
}

// SW 通知:数据库有更新
function showDbUpdateToast() {
  let toast = document.getElementById('update-toast');
  if (!toast) {
    toast = document.createElement('button');
    toast.id = 'update-toast';
    toast.className = 'update-toast';
    toast.textContent = '数据库已更新 · 点击刷新';
    document.body.appendChild(toast);
    toast.addEventListener('click', () => location.reload());
  }
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 15000);
}
window.__showDbUpdateToast = showDbUpdateToast;

// ===== 入口 =====
async function init() {
  const progressEl = document.getElementById('db-loading-progress');

  if (progressEl) progressEl.textContent = '正在初始化数据库引擎...';
  await ensureSqlJs();
  SQL = await initSqlJs({ locateFile });

  await waitSwControlOrTimeout(1200);
  await initFromLoadStage();
}

// 数据阶段(重试时从这里局部重入,WASM 引擎已就绪)
let stageInitialized = false; // 防止重试路径重复绑定事件/重复填充下拉

async function initFromLoadStage() {
  const overlay = document.getElementById('db-loading-overlay');
  const progressEl = document.getElementById('db-loading-progress');

  if (progressEl) {
    progressEl.textContent = '正在下载论文数据库...';
    progressEl.hidden = false;
  }
  const buf = await loadDb((received, total) => {
    if (!progressEl) return;
    const mb = (n) => (n / 1048576).toFixed(1);
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      progressEl.textContent = `正在下载论文数据库... ${pct}%（${mb(received)} / ${mb(total)} MB）`;
    } else {
      progressEl.textContent = `正在下载论文数据库... 已下载 ${mb(received)} MB`;
    }
  });

  if (progressEl) progressEl.textContent = '正在解压并打开数据库...';
  db = new SQL.Database(buf);

  if (!stageInitialized) {
    stageInitialized = true;
    await populateFilters();
    renderLastUpdated();
    applyStateFromUrl();   // 必须在 populateFilters 之后(校验选项存在)
    bindEvents();          // popstate 监听在首次恢复之后注册
    updateBilingualButton();
    updateExpandAllButton();
    setupClickTracking();
    window.trackVisits?.();
  } else {
    renderLastUpdated();
  }
  runSearch();

  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 400);
  }
  navigator.storage?.persist?.().catch(() => {});
}

// 数据库加载失败:overlay 内展示逐源错误 + 局部重试
function showLoadError(err) {
  const card = document.querySelector('.db-loading-card');
  const errBox = document.getElementById('db-load-error');
  const ul = document.getElementById('db-load-error-list');
  const progressEl = document.getElementById('db-loading-progress');
  if (!card || !errBox || !ul) { showErr(err); return; }

  card.classList.add('is-error');
  if (progressEl) progressEl.textContent = '';
  const attempts = (err && err.attempts) || [{ label: '加载', err: summarizeErr(err) }];
  ul.innerHTML = attempts
    .map(a => `<li><strong>${escapeHtml(a.label)}</strong>：${escapeHtml(a.err)}</li>`)
    .join('');
  errBox.hidden = false;

  const retry = document.getElementById('db-retry');
  if (retry) retry.onclick = async () => {
    card.classList.remove('is-error');
    errBox.hidden = true;
    try {
      await initFromLoadStage();
    } catch (e2) {
      showLoadError(e2);
    }
  };
}

// 回到顶部按钮
function setupFabGroup() {
  const topBtn = document.getElementById('back-to-top');
  if (!topBtn) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        const show = document.documentElement.scrollTop > 200 || document.body.scrollTop > 200;
        topBtn.style.display = show ? 'flex' : 'none';
        ticking = false;
      });
      ticking = true;
    }
  });

  topBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ===== 全局按钮点击追踪 =====
function setupClickTracking() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    let action;
    if (btn.classList.contains('tab')) action = 'tab';
    else if (btn.classList.contains('tag-btn')) action = 'tag';
    else if (btn.classList.contains('range-btn')) action = 'range';
    else if (btn.classList.contains('pager-btn')) action = 'page';
    else if (btn.classList.contains('pager-goto-btn')) action = 'goto';
    else if (btn.classList.contains('btn-bilingual-full') || btn.classList.contains('btn-bilingual')) action = 'bilingual';
    else if (btn.classList.contains('btn-reset-all')) action = 'reset_all';
    else if (btn.id === 'reset') action = 'reset_search';
    else if (btn.id === 'back-to-top') action = 'back_top';
    else if (btn.id === 'empty-reset') action = 'reset_empty';
    else if (btn.id === 'export-csv') action = 'export_csv';
    else if (btn.id === 'export-bib') action = 'export_bib';
    else if (btn.classList.contains('copy-doi')) action = 'copy_doi';
    else if (btn.id === 'toggle-abs') action = 'expand_toggle';
    else if (btn.classList.contains('abs-toggle')) action = 'abs_toggle';
    else if (btn.id === 'db-retry') action = 'db_retry';
    else if (btn.id === 'update-toast') action = 'db_toast_refresh';
    else action = btn.id || 'other';

    trackClick(action);
  });
}

async function populateFilters() {
  // journals(带计数)
  const journals = query(`
    SELECT journal AS j, COUNT(*) c
    FROM articles
    WHERE journal IS NOT NULL AND TRIM(journal) <> ''
    GROUP BY journal
    ORDER BY c DESC, j ASC
  `);
  const selJ = document.getElementById('journal');
  journals.forEach(({ j, c }) => {
    const opt = document.createElement('option');
    opt.value = j;
    opt.textContent = `${j} (${Number(c).toLocaleString()})`;
    selJ.appendChild(opt);
  });

  // types(归一化合并 + 计数)
  const typeRows = query(`
    SELECT type AS t, COUNT(*) c
    FROM articles
    WHERE t IS NOT NULL AND TRIM(t) <> ''
    GROUP BY type
  `);
  const canonCounts = new Map();
  typeRows.forEach(({ t, c }) => {
    const canon = TYPE_CANON[t] || t;
    canonCounts.set(canon, (canonCounts.get(canon) || 0) + Number(c));
  });
  const typeSelector = document.getElementById('type-selector');
  while (typeSelector.children.length > 1) {
    typeSelector.removeChild(typeSelector.lastChild);
  }
  Array.from(canonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, c]) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = `${t} (${c.toLocaleString()})`;
      typeSelector.appendChild(opt);
    });

  // tags(带计数)
  const rows = query(`
    SELECT topic_tag FROM articles
    WHERE topic_tag IS NOT NULL AND TRIM(topic_tag) <> ''
  `);
  const tagCount = new Map();
  rows.forEach(r => parseTags(r.topic_tag).forEach(t => tagCount.set(t, (tagCount.get(t) || 0) + 1)));

  const tags = Array.from(tagCount.keys());
  tags.sort((a, b) => {
    if (a === '生命科学') return -1;
    if (b === '生命科学') return 1;
    if (a === '其他') return 1;
    if (b === '其他') return -1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });

  const container = document.getElementById('tag-buttons');
  container.innerHTML = '';
  tags.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'btn tag-btn';
    btn.type = 'button';
    btn.textContent = `${t} ${tagCount.get(t).toLocaleString()}`;
    const colors = getTagColors(t);
    btn.style.setProperty('--tag-bg', colors.active);
    btn.style.setProperty('--tag-bg-light', colors.inactive);
    btn.setAttribute('data-tag', t);
    btn.setAttribute('aria-pressed', 'false');
    btn.title = `筛选标签：${t}`;

    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-tag');
      const willPress = btn.getAttribute('aria-pressed') !== 'true';

      // 三个主题标签互斥
      if (EXCLUSIVE_TAGS.has(tag) && willPress) {
        document.querySelectorAll('.tag-btn.is-active').forEach(b => {
          const other = b.getAttribute('data-tag');
          if (other && EXCLUSIVE_TAGS.has(other) && other !== tag) {
            b.classList.remove('is-active');
            b.setAttribute('aria-pressed', 'false');
          }
        });
      }

      btn.setAttribute('aria-pressed', String(willPress));
      btn.classList.toggle('is-active', willPress);

      PAGE = 1;
      runSearch();
    });

    container.appendChild(btn);
  });
}
const EXCLUSIVE_TAGS = new Set(['生命科学', '人工智能', '3D打印和增材制造', '其他']);

// ===== 事件绑定 =====
function bindEvents() {
  const $ = (id) => document.getElementById(id);

  const q = $('q');
  if (q) {
    const debounced = debounce(() => { PAGE = 1; runSearch(); }, 200);
    q.addEventListener('input', debounced);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  const j = $('journal'); if (j) j.addEventListener('change', () => { PAGE = 1; runSearch(); });
  const df = $('date_from'); if (df) df.addEventListener('change', () => { PAGE = 1; runSearch(); });
  const dt = $('date_to');   if (dt) dt.addEventListener('change', () => { PAGE = 1; runSearch(); });

  const typeSelector = $('type-selector');
  if (typeSelector) typeSelector.addEventListener('change', () => { PAGE = 1; runSearch(); });

  const sortSel = $('sort');
  if (sortSel) sortSel.addEventListener('change', () => { state.sort = sortSel.value; runSearch(); });

  // 搜索框内 X 按钮:只清空关键词
  const resetQ = $('reset');
  if (resetQ) resetQ.onclick = () => {
    if (q) q.value = '';
    PAGE = 1; runSearch();
  };

  // 重置所有筛选条件
  const resetAll = $('reset-all');
  if (resetAll) resetAll.onclick = () => {
    if (q) q.value = '';
    if (j) j.value = '';
    if (df) df.value = '';
    if (dt) dt.value = '';
    document.querySelectorAll('.tag-btn.is-active').forEach(b => {
      b.classList.remove('is-active'); b.setAttribute('aria-pressed', 'false');
    });
    const ts = $('type-selector');
    if (ts) ts.value = '';
    const ss = $('sort');
    if (ss) { ss.value = 'date-desc'; state.sort = 'date-desc'; }
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    PAGE = 1; runSearch();
  };

  const emptyReset = $('empty-reset');
  if (emptyReset) {
    emptyReset.onclick = () => { resetAll?.click(); };
  }

  // 分页
  const prev = $('prev');
  if (prev) prev.onclick = () => {
    if (PAGE > 1) {
      PAGE--;
      runSearch();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const next = $('next');
  if (next) next.onclick = () => {
    if (PAGE < TOTAL_PAGES) {
      PAGE++;
      runSearch();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const gotoInput = $('goto-page');
  const gotoBtn = $('goto-btn');

  function gotoPageFromInput() {
    const raw = (gotoInput?.value || '').trim();
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    const target = Math.max(1, Math.min(TOTAL_PAGES, Math.floor(num)));
    if (target !== PAGE) {
      PAGE = target;
      runSearch();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  if (gotoBtn) gotoBtn.onclick = gotoPageFromInput;
  if (gotoInput) {
    gotoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        gotoPageFromInput();
      }
    });
  }

  // 双语开关
  const biBtn = $('bilingual-toggle-float');
  if (biBtn) {
    biBtn.addEventListener('click', () => {
      state.bilingual = !state.bilingual;
      updateBilingualButton();
      runSearch('bilingual');
    });
  }

  // 快捷时间
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => setQuickRange(btn.dataset.range));
  });

  // 摘要展开/收起(事件委托:单卡按钮)
  const listEl = $('list');
  if (listEl) listEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('.abs-toggle');
    if (!toggle) return;
    const abs = toggle.parentElement.querySelector('.abs');
    if (!abs) return;
    const collapsed = abs.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '展开' : '收起';
  });

  // 全部展开/收起摘要
  const toggleAbs = $('toggle-abs');
  if (toggleAbs) toggleAbs.onclick = () => {
    state.expandAll = !state.expandAll;
    localStorage.setItem('pt_expand_abs', state.expandAll ? '1' : '0');
    updateExpandAllButton();
    runSearch();
  };

  // 复制 DOI(事件委托)
  if (listEl) listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-doi');
    if (!btn) return;
    const doi = btn.getAttribute('data-doi');
    if (!doi) return;
    try {
      await navigator.clipboard.writeText(doi);
      const original = btn.textContent;
      btn.textContent = '✓ 已复制';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
    } catch (_) {
      btn.textContent = '复制失败';
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    }
  });

  // 导出
  const exportCsvBtn = $('export-csv');
  if (exportCsvBtn) exportCsvBtn.onclick = () => exportResults('csv');
  const exportBibBtn = $('export-bib');
  if (exportBibBtn) exportBibBtn.onclick = () => exportResults('bibtex');

  // 键盘快捷键:/ 聚焦搜索、←/→ 翻页
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('input, select, textarea');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('q')?.focus();
      return;
    }
    if (typing) return;
    if (e.key === 'ArrowLeft' && PAGE > 1) { prev?.click(); }
    else if (e.key === 'ArrowRight' && PAGE < TOTAL_PAGES) { next?.click(); }
  });

  // 浏览器前进/后退恢复筛选状态
  window.addEventListener('popstate', () => {
    restoringFromPop = true;
    try {
      applyStateFromUrl();
      runSearch();
    } finally {
      setTimeout(() => { restoringFromPop = false; }, 350); // 晚于 syncUrl 的 300ms 防抖窗口
    }
  });
}

function updateExpandAllButton() {
  const btn = document.getElementById('toggle-abs');
  if (btn) btn.textContent = state.expandAll ? '收起全部摘要' : '全部展开摘要';
}

// 简易防抖
function debounce(fn, wait=200){
  let t; return (...args) => { clearTimeout(t); t = setTimeout(()=>fn.apply(null,args), wait); };
}

// 快捷时间
function setQuickRange(range) {
  const $ = (id) => document.getElementById(id);
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);

  if (range === '3d') start.setDate(end.getDate() - 2);
  else if (range === '7d') start.setDate(end.getDate() - 6);
  else if (range === '30d') start.setDate(end.getDate() - 29);

  const fmtLocal = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const da = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${da}`;
  };

  $('date_from').value = fmtLocal(start);
  $('date_to').value   = fmtLocal(end);

  document.querySelectorAll('.range-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === range);
  });

  PAGE = 1; runSearch();
}

// ===== URL 状态同步(query 参数) =====
function currentTab() {
  const active = document.querySelector('.tab-content.active');
  return active ? (active.id === 'about' ? 'about' : 'search') : 'search';
}

function buildSearchParams() {
  const getVal = (id) => (document.getElementById(id)?.value ?? '').trim();
  const p = new URLSearchParams();
  if (getVal('q')) p.set('q', getVal('q'));
  if (getVal('date_from')) p.set('from', getVal('date_from'));
  if (getVal('date_to')) p.set('to', getVal('date_to'));
  if (getVal('journal')) p.set('journal', getVal('journal'));
  if (getVal('type-selector')) p.set('type', getVal('type-selector'));
  const tags = Array.from(document.querySelectorAll('.tag-btn.is-active'))
    .map(b => b.getAttribute('data-tag')).filter(Boolean);
  if (tags.length) p.set('tags', tags.join(','));
  if (PAGE > 1) p.set('page', String(PAGE));
  if (state.bilingual) p.set('bi', '1');
  if (state.sort !== 'date-desc') p.set('sort', state.sort);
  if (currentTab() === 'about') p.set('tab', 'about');
  return p;
}

// 写路径收口:所有筛选变更都汇聚到 runSearch(),在末尾统一回写 URL
const syncUrlDebounced = debounce(() => {
  if (restoringFromPop) return;
  const qs = buildSearchParams().toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}, 300);

// 读路径:纯设值,不触发查询(时序上必须在 populateFilters 之后)
function applyStateFromUrl() {
  const p = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const v = (k) => (p.get(k) || '').trim();

  if (v('q')) $('q').value = v('q');
  if (/^\d{4}-\d{2}-\d{2}$/.test(v('from'))) $('date_from').value = v('from');
  if (/^\d{4}-\d{2}-\d{2}$/.test(v('to')))   $('date_to').value   = v('to');

  const optOk = (sel, val) => val && [...$(sel).options].some(o => o.value === val);
  if (optOk('journal', v('journal'))) $('journal').value = v('journal');
  if (optOk('type-selector', v('type'))) $('type-selector').value = v('type');
  if (optOk('sort', v('sort') || 'date-desc')) {
    $('sort').value = v('sort') || 'date-desc';
    state.sort = $('sort').value;
  }

  const valid = new Set([...document.querySelectorAll('.tag-btn')].map(b => b.dataset.tag));
  document.querySelectorAll('.tag-btn.is-active').forEach(b => {
    b.classList.remove('is-active');
    b.setAttribute('aria-pressed', 'false');
  });
  v('tags').split(',').map(s => s.trim()).filter(t => valid.has(t)).forEach(t => {
    const b = document.querySelector(`.tag-btn[data-tag="${CSS.escape(t)}"]`);
    if (b) { b.classList.add('is-active'); b.setAttribute('aria-pressed', 'true'); }
  });

  const pg = parseInt(v('page'), 10);
  PAGE = Number.isFinite(pg) && pg >= 1 ? pg : 1;

  state.bilingual = v('bi') === '1';
  if (v('tab') === 'about') document.querySelector('.tab[data-target="about"]')?.click();
}

// ===== 查询构造 =====
function orderByClause() {
  return state.sort === 'date-asc'
    ? 'ORDER BY pub_date ASC, fetched_at ASC, uid ASC'
    : 'ORDER BY pub_date DESC, fetched_at DESC, uid DESC';
}

function buildWhere() {
  const getVal = (id) => (document.getElementById(id)?.value ?? '').trim();

  const kwRaw   = getVal('q');
  const journal = getVal('journal');
  const df      = getVal('date_from');
  const dt      = getVal('date_to');

  // 关键词:逗号或空白分隔,AND;与高亮分词规则一致
  const kwTerms = kwRaw ? kwRaw.split(/[,\s]+/).filter(Boolean) : [];

  const selectedTags = Array.from(document.querySelectorAll('.tag-btn.is-active'))
    .map(b => b.getAttribute('data-tag'))
    .filter(Boolean);

  const typeSelector = document.getElementById('type-selector');
  const selectedType = typeSelector && typeSelector.value ? typeSelector.value : '';

  const clauses = [];
  const params  = {};

  kwTerms.forEach((term, i) => {
    const k = `:kw${i}`;
    clauses.push("(" +
      "title_en    LIKE " + k + " OR " +
      "title_cn    LIKE " + k + " OR " +
      "abstract_en LIKE " + k + " OR " +
      "abstract_cn LIKE " + k + " OR " +
      "doi         LIKE " + k +
    ")");
    params[k] = `%${term}%`;
  });

  if (journal) {
    clauses.push("journal = :journal");
    params[":journal"] = journal;
  }

  if (df) { clauses.push("(pub_date >= :df)"); params[":df"] = df; }
  if (dt) { clauses.push("(pub_date <= :dt)"); params[":dt"] = dt; }

  selectedTags.forEach((t, i) => {
    const kj = `:tgjson${i}`;
    const kp = `:tgplain${i}`;
    clauses.push(`(topic_tag LIKE ${kj} OR topic_tag LIKE ${kp})`);
    params[kj] = `%"${t}"%`;
    params[kp] = `%${t}%`;
  });

  // 类型:选中归一化类型时,展开为所有原始变体的 IN 查询
  if (selectedType) {
    const variants = [];
    for (const [raw, canon] of Object.entries(TYPE_CANON)) {
      if (canon === selectedType) variants.push(raw);
    }
    variants.push(selectedType);
    const ph = variants.map((_, i) => `:ty${i}`);
    clauses.push(`(type IN (${ph.join(', ')}))`);
    variants.forEach((t, i) => { params[`:ty${i}`] = t; });
  }

  const where = clauses.length ? ("WHERE " + clauses.join(" AND ")) : "";
  return { where, params, kw: kwRaw };
}

function runSearch(animateMode = 'filter') {
  const listEl = document.getElementById('list');
  const loadingEl = document.getElementById('search-loading');
  const emptyEl = document.getElementById('empty-state');
  const statsEl = document.getElementById('stats');

  if (loadingEl) loadingEl.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  const { where, params, kw } = buildWhere();

  const cntRow = query(`SELECT COUNT(*) AS n FROM articles ${where}`, params)[0];
  const total = cntRow ? cntRow.n : 0;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (PAGE > totalPages) PAGE = totalPages; // 分享链接页码越界:静默修正

  const offset = (PAGE - 1) * PAGE_SIZE;

  const rows = query(`
    SELECT
      uid,
      journal,
      type,
      topic_tag,
      pub_date,
      doi,
      article_url,
      title_en, title_cn,
      abstract_en, abstract_cn
    FROM articles
    ${where}
    ${orderByClause()}
    LIMIT :limit OFFSET :offset
  `, { ...params, ":limit": PAGE_SIZE, ":offset": offset });

  if (loadingEl) loadingEl.hidden = true;

  if (total === 0 && rows.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.hidden = false;
      const hint = emptyEl.querySelector('.empty-state-hint');
      if (hint) {
        const badRange = params[':df'] && params[':dt'] && params[':df'] > params[':dt'];
        hint.textContent = badRange
          ? '起始日期晚于终止日期，请调整日期区间'
          : '请尝试调整关键词、日期范围或筛选项';
      }
    }
    document.getElementById('pageinfo').textContent = '';
    document.getElementById('pagecount').textContent = '';
  } else {
    if (emptyEl) emptyEl.hidden = true;
    document.getElementById('pageinfo').textContent = `第 ${PAGE} 页`;
    document.getElementById('pagecount').textContent = ` / 共 ${totalPages} 页`;
    render(rows, kw, animateMode);
  }

  animateCount(statsEl, total);

  TOTAL_PAGES = totalPages;
  document.getElementById('prev').disabled = PAGE <= 1;
  document.getElementById('next').disabled = (offset + rows.length) >= total;

  const gp = document.getElementById('goto-page');
  if (gp) gp.value = String(PAGE);

  syncUrlDebounced();
}

// ===== 导出(按当前筛选全量) =====
function exportResults(kind) {
  const { where, params } = buildWhere();
  const rows = query(`
    SELECT uid, journal, type, topic_tag, pub_date, doi, article_url,
           title_en, title_cn, abstract_en, abstract_cn
    FROM articles
    ${where}
    ${orderByClause()}
  `, params);

  if (!rows.length) { alert('当前筛选没有可导出的结果'); return; }

  const stamp = todayStr().replace(/-/g, '');
  if (kind === 'csv') {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const header = ['uid', 'journal', 'type', 'pub_date', 'doi', 'url', 'title_en', 'title_cn', 'abstract_en', 'abstract_cn'];
    const lines = [header.join(',')];
    rows.forEach(r => {
      lines.push([
        r.uid, r.journal, r.type, r.pub_date, r.doi, r.article_url,
        r.title_en, r.title_cn, r.abstract_en, r.abstract_cn,
      ].map(esc).join(','));
    });
    // ﻿ BOM:Excel 直接打开中文不乱码
    downloadBlob('﻿' + lines.join('\r\n'), `paper-tracker-${stamp}.csv`, 'text/csv;charset=utf-8');
  } else {
    const bibEsc = (s) => String(s ?? '').replace(/([\\{}])/g, '\\$1');
    const key = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const out = rows.map(r => {
      const year = (fmtDate(r.pub_date) || '').slice(0, 4);
      const fields = [
        `title = {${bibEsc(r.title_en || r.title_cn || '')}}`,
        `journal = {${bibEsc(r.journal || '')}}`,
        year && `year = {${year}}`,
        r.doi && `doi = {${bibEsc(r.doi)}}`,
        r.article_url && `url = {${bibEsc(r.article_url)}}`,
        r.title_cn && `note = {${bibEsc(r.title_cn)}}`,
      ].filter(Boolean);
      return `@article{${key(r.uid)},\n  ${fields.join(',\n  ')}\n}`;
    }).join('\n\n');
    downloadBlob(out, `paper-tracker-${stamp}.bib`, 'application/x-bibtex;charset=utf-8');
  }
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ===== FLIP 高度弹性动画 =====
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

function recordChildPos(listEl) {
  const map = new Map();
  listEl.querySelectorAll('.card').forEach(card => {
    if (!card.dataset.uid) return;
    const top = card.getBoundingClientRect().top;
    const pos = [];
    card.querySelectorAll(':scope > *').forEach(c => {
      pos.push(c.getBoundingClientRect().top - top);
    });
    map.set(card.dataset.uid, pos);
  });
  return map;
}

function springProp(el, prop, from, to) {
  el.style.transition = 'none';
  el.style[prop] = from;
  void el.offsetHeight;
  el.style.transition = `${prop} 400ms ${SPRING}`;
  el.style[prop] = to;
  const done = () => { el.style[prop] = ''; el.style.transition = ''; };
  el.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 500);
}

function flipChildren(card, uid, oMap, nMap) {
  const oPos = oMap.get(uid);
  const nPos = nMap.get(uid);
  if (!oPos || !nPos) return;
  const children = card.querySelectorAll(':scope > *');
  const len = Math.min(oPos.length, nPos.length, children.length);
  for (let i = 0; i < len; i++) {
    const delta = nPos[i] - oPos[i];
    if (Math.abs(delta) < 1) continue;
    springProp(children[i], 'transform', `translateY(${-delta}px)`, 'translateY(0)');
  }
}

// 摘要默认折叠:渲染后测量,溢出才显示「展开」按钮
function markOverflowingAbstracts(listEl) {
  requestAnimationFrame(() => {
    listEl.querySelectorAll('.abs.collapsed').forEach(abs => {
      if (abs.scrollHeight > abs.clientHeight + 6) {
        const btn = abs.parentElement.querySelector('.abs-toggle');
        if (btn) btn.hidden = false;
      }
    });
  });
}

function render(items, kw, mode = 'filter') {
  const el = document.getElementById('list');

  const oldHeights = new Map();
  if (mode === 'bilingual') {
    el.querySelectorAll('.card').forEach(card => {
      if (card.dataset.uid) {
        oldHeights.set(card.dataset.uid, card.offsetHeight);
      }
    });
  }

  const html = items.map(it => {
    const tags = parseTags(it.topic_tag);
    const tagsHtml = tags.length
      ? `<div class="tags">` + tags.map(t => `
          <span class="tag-chip" style="--tag-bg:${getTagColors(t).active}">${escapeHtml(t)}</span>
        `).join('') + `</div>`
      : '';

    const typeCanon = TYPE_CANON[it.type] || it.type;
    const meta = [
      `<span><strong>期刊：</strong>${escapeHtml(it.journal || '')}</span>`,
      typeCanon ? `<span><strong>类型：</strong>${escapeHtml(typeCanon)}</span>` : '',
      `<span><strong>发表日期：</strong>${fmtDate(it.pub_date)}</span>`
    ].filter(Boolean).join(' · ');

    let titleHTML = '';
    let absHTML = '';

    const absToggle = state.expandAll
      ? ''
      : `<button class="abs-toggle" type="button" hidden>展开</button>`;

    if (state.bilingual) {
      const ten = it.title_en ? `<div class="t-en">${highlightAndEscape(it.title_en, kw)}</div>` : '';
      const tcn = it.title_cn ? `<div class="t-cn">${highlightAndEscape(it.title_cn, kw)}</div>` : '';
      const aen = it.abstract_en ? `<div class="a-en">${highlightAndEscape(it.abstract_en, kw)}</div>` : '';
      const acn = it.abstract_cn ? `<div class="a-cn">${highlightAndEscape(it.abstract_cn, kw)}</div>` : '';
      const hasTitle = ten || tcn;
      titleHTML = `<div class="title">${hasTitle ? (ten + tcn) : '(无标题)'}</div>`;
      const absContent = aen + acn;
      absHTML = absContent
        ? `<div class="abs-wrap"><div class="abs${state.expandAll ? '' : ' collapsed'}">${absContent}</div>${absToggle}</div>`
        : '';
    } else {
      const titlePref = it.title_en || it.title_cn || '(无标题)';
      const absPref   = it.abstract_en || it.abstract_cn || '';
      titleHTML = `<div class="title">${highlightAndEscape(titlePref, kw)}</div>`;
      absHTML = absPref
        ? `<div class="abs-wrap"><div class="abs${state.expandAll ? '' : ' collapsed'}">${highlightAndEscape(absPref, kw)}</div>${absToggle}</div>`
        : '';
    }

    const doi = it.doi
      ? `<span class="doi-group"><span class="badge">DOI</span> <a href="https://doi.org/${escapeHtml(it.doi)}" target="_blank" rel="noopener">${escapeHtml(it.doi)}</a>` +
        ` <button class="copy-doi" type="button" data-doi="${escapeHtml(it.doi)}" title="复制 DOI">复制</button></span>`
      : '';
    const link = it.article_url ? `<a href="${escapeHtml(it.article_url)}" target="_blank" rel="noopener">原文链接</a>` : '';

    return `
      <div class="card" data-uid="${escapeHtml(String(it.uid))}">
        ${titleHTML}
        ${tagsHtml}
        <div class="meta">${meta}</div>
        ${absHTML}
        <div class="meta">${doi} ${link}</div>
      </div>
    `;
  }).join('');

  if (mode === 'bilingual' && oldHeights.size > 0) {

    if (!state.bilingual) {
      // ===== 关闭双语 =====
      const oldCP = recordChildPos(el);

      const cnNodes = el.querySelectorAll('.t-cn, .a-cn');
      cnNodes.forEach(n => n.style.display = 'none');
      const newCP = recordChildPos(el);
      const newHeights = new Map();
      el.querySelectorAll('.card').forEach(card => {
        if (card.dataset.uid) newHeights.set(card.dataset.uid, card.offsetHeight);
      });
      cnNodes.forEach(n => n.style.display = '');

      cnNodes.forEach(node => {
        node.style.transition = 'opacity 300ms ease, transform 300ms ease';
        node.style.opacity = '0';
        node.style.transform = 'translateY(-8px)';
      });

      el.querySelectorAll('.card').forEach(card => {
        const uid = card.dataset.uid;
        const oldH = oldHeights.get(uid);
        const newH = newHeights.get(uid);

        if (oldH != null && newH != null && Math.abs(newH - oldH) > 2) {
          card.style.height = oldH + 'px';
          void card.offsetHeight;
          card.style.transition = `height 400ms ${SPRING}`;
          card.style.height = newH + 'px';
        }

        const oPos = oldCP.get(uid);
        const nPos = newCP.get(uid);
        if (oPos && nPos) {
          const children = card.querySelectorAll(':scope > *');
          const len = Math.min(oPos.length, nPos.length, children.length);
          for (let i = 0; i < len; i++) {
            const delta = nPos[i] - oPos[i];
            if (Math.abs(delta) < 1) continue;
            children[i].style.transition = `transform 400ms ${SPRING}`;
            children[i].style.transform = `translateY(${delta}px)`;
          }
        }
      });

      setTimeout(() => {
        el.innerHTML = html;
        el.classList.remove('fade-in');
        markOverflowingAbstracts(el);
      }, 480);

    } else {
      // ===== 开启双语 =====
      const oldCP = recordChildPos(el);
      el.innerHTML = html;
      el.classList.remove('fade-in');
      el.classList.add('bilingual-anim');

      const newCP = recordChildPos(el);
      el.querySelectorAll('.card').forEach(card => {
        const uid = card.dataset.uid;
        const oldH = oldHeights.get(uid);
        if (oldH == null) return;
        const newH = card.offsetHeight;
        if (Math.abs(newH - oldH) > 2) {
          springProp(card, 'height', oldH + 'px', newH + 'px');
        }
        flipChildren(card, uid, oldCP, newCP);
      });
      markOverflowingAbstracts(el);

      setTimeout(() => el.classList.remove('bilingual-anim'), 500);
    }

  } else {
    // 筛选变化:淡入淡出
    el.classList.remove('fade-in');
    const oldCards = el.querySelectorAll('.card');
    if (oldCards.length === 0) {
      el.innerHTML = html;
      el.classList.add('fade-in');
      markOverflowingAbstracts(el);
      return;
    }

    oldCards.forEach(c => {
      c.style.opacity = '0';
      c.style.transform = 'translateY(-6px)';
    });
    setTimeout(() => {
      el.innerHTML = html;
      el.classList.add('fade-in');
      markOverflowingAbstracts(el);
    }, 180);
  }
}

function showErr(err){
  const el = document.getElementById('list');
  console.error(err);
  if (el) el.innerHTML = `<pre class="err-box">${escapeHtml(err.stack || String(err))}</pre>`;
}

// tab 切换由 index.html 内联脚本驱动;切换后同步 URL(见 buildSearchParams 的 tab 参数)
window.__syncTab = () => syncUrlDebounced();

// ===== 启动 =====
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    init().catch(showLoadError);
    setupFabGroup();
  });
} else {
  init().catch(showLoadError);
  setupFabGroup();
}
