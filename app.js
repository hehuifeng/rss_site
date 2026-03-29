// Patched for schema:
// articles(uid, feed_url, journal, title_en, title_cn, type, pub_date, doi,
//          article_url, abstract_en, abstract_cn, raw_jsonld, fetched_at, last_updated_at, topic_tag)

let db, SQL;
let PAGE = 1, PAGE_SIZE = 30;
let TOTAL_PAGES = 1;

const state = {
  bilingual: false,
};

// 更新双语显示按钮文本
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

// ===== 真实访问统计（服务端计数）=====
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

function _beacon(url, obj) {
  try {
    navigator.sendBeacon(url, new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  } catch (_) {}
}

function trackClick(action) {
  _beacon(`${_M}/click`, { a: action });
}

function trackVisits() {
  _beacon(`${_M}/visit`, { uv_id: getUvId() });
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
  // 逗号或空白都作为分隔
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

// 把一个 hsl(...) 字符串的亮度调高（生成浅色）
function lightenHsl(hslStr, delta = 18) {
  // 兼容两种常见格式："hsl(h s% l%)"（本项目使用此格式）
  const m = /hsl\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)/i.exec(hslStr);
  if (!m) return hslStr;
  const hue = Number(m[1]);
  const sat = Number(m[2]);
  const light = Number(m[3]);
  const nl = Math.min(95, Math.max(0, Math.round(light + delta)));
  return `hsl(${hue} ${sat}% ${nl}%)`;
}

function getTagColors(tag) {
  // 预定义颜色，避免哈希碰撞
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
// 解析 topic_tag 为 tag 数组：优先 JSON.parse，失败再按老的分隔符切分
function parseTags(raw) {
  if (!raw) return [];
  const s = String(raw).trim();

  // 优先尝试 JSON 数组（如 '["生命科学","人工智能"]'）
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
    try {
      const parsed = JSON.parse(s);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return Array.from(
        new Set(
          arr
            .map(x => String(x).trim())
            .filter(Boolean)
        )
      );
    } catch (e) {
      // 不是合法 JSON，退回到普通切分
    }
  }

  // 兼容旧格式：逗号/分号/竖线/空白等
  return Array.from(
    new Set(
      s
        .split(/[,;｜|，；/]+|\s+/g)
        .map(t => t.replace(/^"+|"+$/g, '').trim()) // 去掉意外的包裹引号
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
function setDefaultDatesOnce(){
  const dt = document.getElementById('date_to');
  // 仅当用户尚未手动选择时，给终止日期赋值为今天
  if (dt && !dt.value) dt.value = todayStr();
}
// 把 last_updated_at 格式化为本地“YYYY-MM-DD HH:MM”
function fmtLocalDateTime(input){
  if (!input) return '';
  // 兼容三种常见格式：ISO 字符串 / 秒级时间戳 / 毫秒级时间戳
  let d;
  if (/^\d{13}$/.test(String(input))) {
    d = new Date(Number(input));              // ms
  } else if (/^\d{10}$/.test(String(input))) {
    d = new Date(Number(input) * 1000);       // s
  } else {
    d = new Date(String(input));              // ISO
  }
  if (isNaN(d)) return String(input);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const da = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${y}-${m}-${da} ${hh}:${mm}`;
}

// 查询全库最近更新时间并渲染
function renderLastUpdated(){
  try{
    const row = query(`SELECT COUNT(*) AS n, MAX(last_updated_at) AS ts FROM articles`)[0];
    const el = document.getElementById('db-updated');
    if (el && row) {
      const ts = row.ts ? fmtLocalDateTime(row.ts) : '—';
      el.textContent = `数据库共 ${row.n} 条 · 最近更新：${fmtLocalDateTime(row.ts)}`;
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

// ===== 入口 =====
async function init() {
  const overlay = document.getElementById('db-loading-overlay');
  const progressEl = document.getElementById('db-loading-progress');

  // 阶段1：加载 SQL.js WASM
  if (progressEl) progressEl.textContent = '正在初始化数据库引擎...';
  await ensureSqlJs();
  SQL = await initSqlJs({ locateFile });

  // 阶段2：下载数据库（带进度）
  if (progressEl) progressEl.textContent = '正在下载论文数据库（约 15MB）...';
  const res = await fetch('data/rss_state.db');
  const contentLength = res.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  let received = 0;
  const reader = res.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0 && progressEl) {
      const pct = Math.round((received / total) * 100);
      progressEl.textContent = `正在下载论文数据库... ${pct}%（${(received / 1024 / 1024).toFixed(1)} MB）`;
    }
  }

  // 合并 chunks
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const buf = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }

  if (progressEl) progressEl.textContent = '正在打开数据库...';
  db = new SQL.Database(buf);

  // 隐藏 loading overlay（带淡出动画）
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 400);
  }

  await populateFilters();
  renderLastUpdated();
  bindEvents();
  updateBilingualButton();
  setupClickTracking();
  window.trackVisits?.();
  runSearch();
}

// 回到顶部按钮逻辑
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
    else action = btn.id || 'other';

    trackClick(action);
  });
}



async function populateFilters() {
  // journals
  const journals = query(`
    SELECT journal AS j, COUNT(*) c
    FROM articles
    WHERE journal IS NOT NULL AND TRIM(journal) <> ''
    GROUP BY journal
    ORDER BY c DESC, j ASC
  `);
  const selJ = document.getElementById('journal');
  journals.forEach(({j}) => {
    const opt = document.createElement('option');
    opt.value = j; opt.textContent = j;
    selJ.appendChild(opt);
  });

  // tags -> 渲染为按钮
  const rows = query(`
    SELECT topic_tag FROM articles
    WHERE topic_tag IS NOT NULL AND TRIM(topic_tag) <> ''
  `);
  const all = new Set();
  rows.forEach(r => parseTags(r.topic_tag).forEach(t => all.add(t)));

  let tags = Array.from(all);
  // types -> 渲染为下拉菜单
  const typeRows = query(`
    SELECT DISTINCT type AS t FROM articles
    WHERE t IS NOT NULL AND TRIM(t) <> ''
    ORDER BY t COLLATE NOCASE
  `);
  const typeSelector = document.getElementById('type-selector');
  // 清空现有选项，保留默认选项
  while (typeSelector.children.length > 1) {
    typeSelector.removeChild(typeSelector.lastChild);
  }
  typeRows
    .map(r => r.t)
    .filter(Boolean)
    .forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      typeSelector.appendChild(opt);
    });
  // 排序规则：生命科学最前，其他最后，其余按拼音/字母序
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
  btn.textContent = t;
  const colors = getTagColors(t);
  // 设置两个 CSS 变量：按下色（--tag-bg）和对应的浅色（--tag-bg-light）
  btn.style.setProperty('--tag-bg', colors.active);
  btn.style.setProperty('--tag-bg-light', colors.inactive);
  btn.setAttribute('data-tag', t);
  btn.setAttribute('aria-pressed', 'false');
    // 三个互斥 tag
    const EXCLUSIVE_TAGS = new Set(['生命科学', '人工智能', '3D打印和增材制造', '其他']);

    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-tag');
      const willPress = btn.getAttribute('aria-pressed') !== 'true';

      // 如果点击的是互斥组内按钮，并且这次要按下
      if (EXCLUSIVE_TAGS.has(tag) && willPress) {
        document.querySelectorAll('.tag-btn.is-active').forEach(b => {
          const t = b.getAttribute('data-tag');
          if (t && EXCLUSIVE_TAGS.has(t) && t !== tag) {
            b.classList.remove('is-active');
            b.setAttribute('aria-pressed', 'false');
          }
        });
      }

      // 正常切换自身状态
      btn.setAttribute('aria-pressed', String(willPress));
      btn.classList.toggle('is-active', willPress);

      PAGE = 1;
      runSearch();
    });

    container.appendChild(btn);
  });
}

// ===== 事件绑定（即时触发）=====
function bindEvents() {
  const $ = (id) => document.getElementById(id);

  // 关键词：即时触发（防抖）
  const q = $('q');
  if (q) {
    const debounced = debounce(() => { PAGE = 1; runSearch(); }, 200);
    q.addEventListener('input', debounced);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  // 期刊/日期 改变即筛选
  const j = $('journal'); if (j) j.addEventListener('change', () => { PAGE = 1; runSearch(); });
  const df = $('date_from'); if (df) df.addEventListener('change', () => { PAGE = 1; runSearch(); });
  const dt = $('date_to');   if (dt) dt.addEventListener('change', () => { PAGE = 1; runSearch(); });
  
  // 类型筛选下拉菜单改变即筛选
  const typeSelector = $('type-selector');
  if (typeSelector) typeSelector.addEventListener('change', () => { PAGE = 1; runSearch(); });

  // 搜索框内 X 按钮：只清空关键词
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
    if (dt) dt.value = todayStr();
    // 清空 tag 按钮状态
    document.querySelectorAll('.tag-btn.is-active').forEach(b=>{
      b.classList.remove('is-active'); b.setAttribute('aria-pressed','false');
    });
    // 重置类型筛选下拉菜单
    const typeSelector = $('type-selector');
    if (typeSelector) typeSelector.value = '';
    // 清空快捷时间按钮 active 状态
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    PAGE = 1; runSearch();
  };

  // 空状态重置按钮
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
      window.scrollTo({ top: 0, behavior: 'smooth' }); // ✅ 新增：换页回到顶部
    }
  };

  const next = $('next');
  if (next) next.onclick = () => {
    if (PAGE < TOTAL_PAGES) {          // ✅ 防止越界
      PAGE++;
      runSearch();
      window.scrollTo({ top: 0, behavior: 'smooth' }); // ✅
    }
  };

  // ✅ 新增：手动跳页（输入 + 按钮/回车）
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
      window.scrollTo({ top: 0, behavior: 'smooth' }); // ✅
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

  // 快捷时间按钮
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => setQuickRange(btn.dataset.range));
  });
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

  // 更新快捷按钮 active 状态
  document.querySelectorAll('.range-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === range);
  });

  PAGE = 1; runSearch();
}

// WHERE 构造（支持多关键词、tag AND、type OR、journal、日期区间）
function buildWhere() {
  const getVal = (id) => (document.getElementById(id)?.value ?? '').trim();

  const kwRaw   = getVal('q');        // 原始关键词串（用于前端高亮）
  const journal = getVal('journal');
  const df      = getVal('date_from');
  const dt      = getVal('date_to');

  // 1) 关键词：用英文逗号分隔，AND 逻辑；每个词在多字段 OR
  const kwTerms = kwRaw
    ? kwRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // 2) 选中的 tag（按钮式），AND 逻辑；兼容 JSON 数组/旧文本
  const selectedTags = Array.from(document.querySelectorAll('.tag-btn.is-active'))
    .map(b => b.getAttribute('data-tag'))
    .filter(Boolean);

  // 3) 选中的类型（下拉菜单）
  const typeSelector = document.getElementById('type-selector');
  const selectedTypes = typeSelector && typeSelector.value ? [typeSelector.value] : [];

  const clauses = [];
  const params  = {};

  // 关键词：AND（每个 term 建一组 OR 子句）
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

  // 期刊
  if (journal) {
    clauses.push("journal = :journal");
    params[":journal"] = journal;
  }

  // 日期
  if (df) { clauses.push("(pub_date >= :df)"); params[":df"] = df; }
  if (dt) { clauses.push("(pub_date <= :dt)"); params[":dt"] = dt; }

  // tag：AND；每个 tag 既匹配 JSON 数组中的 "tag" 也兼容旧的包含匹配
  selectedTags.forEach((t, i) => {
    const kj = `:tgjson${i}`;
    const kp = `:tgplain${i}`;
    clauses.push(`(topic_tag LIKE ${kj} OR topic_tag LIKE ${kp})`);
    params[kj] = `%"${t}"%`;  // 精准命中 JSON 数组项
    params[kp] = `%${t}%`;    // 兼容旧纯文本
  });

  // 类型：OR；选 1 个等价于 "="，选多个用 IN (...)
  if (selectedTypes.length === 1) {
    clauses.push("(type = :ty0)");
    params[":ty0"] = selectedTypes[0];
  } else if (selectedTypes.length > 1) {
    const ph = selectedTypes.map((_, i) => `:ty${i}`);
    clauses.push(`(type IN (${ph.join(', ')}))`);
    selectedTypes.forEach((t, i) => { params[`:ty${i}`] = t; });
  }

  const where = clauses.length ? ("WHERE " + clauses.join(" AND ")) : "";
  return { where, params, kw: kwRaw };
}


function runSearch(animateMode = 'filter') {
  const listEl = document.getElementById('list');
  const loadingEl = document.getElementById('search-loading');
  const emptyEl = document.getElementById('empty-state');
  const statsEl = document.getElementById('stats');

  // 显示 loading，隐藏列表和空状态
  if (loadingEl) loadingEl.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  const { where, params, kw } = buildWhere();

  const cntRow = query(`SELECT COUNT(*) AS n FROM articles ${where}`, params)[0];
  const total = cntRow ? cntRow.n : 0;

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
    ORDER BY pub_date DESC, fetched_at DESC, uid DESC
    LIMIT :limit OFFSET :offset
  `, { ...params, ":limit": PAGE_SIZE, ":offset": offset });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 隐藏 loading
  if (loadingEl) loadingEl.hidden = true;

  // 空结果处理
  if (total === 0 && rows.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.hidden = false;
    document.getElementById('pageinfo').textContent = '';
    document.getElementById('pagecount').textContent = '';
  } else {
    if (emptyEl) emptyEl.hidden = true;
    document.getElementById('pageinfo').textContent = `第 ${PAGE} 页`;
    document.getElementById('pagecount').textContent = ` / 共 ${totalPages} 页`;
    render(rows, kw, animateMode);
  }

  // 更新统计（带数字动画）
  animateCount(statsEl, total);

  TOTAL_PAGES = totalPages;
  document.getElementById('prev').disabled = PAGE <= 1;
  document.getElementById('next').disabled = (offset + rows.length) >= total;

  const gp = document.getElementById('goto-page');
  if (gp) gp.value = String(PAGE);
}

// FLIP 高度弹性动画（供 render 调用）
// 弹性曲线
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

// 记录每张卡片直接子元素的相对位置（相对于卡片顶部）
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

// 弹性过渡某个属性，结束后自动清理内联样式
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

// 对卡片内子元素做 FLIP 位移动画
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

function render(items, kw, mode = 'filter') {
  const el = document.getElementById('list');

  // 双语模式：先记录每张卡片的旧高度
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

    const meta = [
      `<span><strong>期刊：</strong>${escapeHtml(it.journal || '')}</span>`,
      it.type ? `<span><strong>类型：</strong>${escapeHtml(it.type)}</span>` : '',
      `<span><strong>发表日期：</strong>${fmtDate(it.pub_date)}</span>`
    ].filter(Boolean).join(' · ');

    let titleHTML = '';
    let absHTML = '';

    if (state.bilingual) {
      const ten = it.title_en ? `<div class="t-en">${highlightAndEscape(it.title_en, kw)}</div>` : '';
      const tcn = it.title_cn ? `<div class="t-cn">${highlightAndEscape(it.title_cn, kw)}</div>` : '';
      const aen = it.abstract_en ? `<div class="a-en">${highlightAndEscape(it.abstract_en, kw)}</div>` : '';
      const acn = it.abstract_cn ? `<div class="a-cn">${highlightAndEscape(it.abstract_cn, kw)}</div>` : '';
      const hasTitle = ten || tcn;
      titleHTML = `<div class="title">${hasTitle ? (ten + tcn) : '(无标题)'}</div>`;
      absHTML   = `<div class="abs">${aen}${acn}</div>`;
    } else {
      const titlePref = it.title_en || it.title_cn || '(无标题)';
      const absPref   = it.abstract_en || it.abstract_cn || '';
      titleHTML = `<div class="title">${highlightAndEscape(titlePref, kw)}</div>`;
      absHTML   = absPref ? `<div class="abs">${highlightAndEscape(absPref, kw)}</div>` : '';
    }

    const doi = it.doi ? `<span class="doi-group"><span class="badge">DOI</span> <a href="https://doi.org/${escapeHtml(it.doi)}" target="_blank" rel="noopener">${escapeHtml(it.doi)}</a></span>` : '';
    const link = it.article_url ? `<a href="${escapeHtml(it.article_url)}" target="_blank" rel="noopener">原文链接</a>` : '';

    return `
      <div class="card" data-uid="${it.uid}">
        ${titleHTML}
        ${tagsHtml}
        <div class="meta">${meta}</div>
        ${absHTML}
        <div class="meta">${doi} ${link}</div>
      </div>
    `;
  }).join('');

  // ===== 动画分两种模式 =====

  if (mode === 'bilingual' && oldHeights.size > 0) {

    if (!state.bilingual) {
      // ===== 关闭双语：文字淡出 + 高度收缩 + 子元素弹性上移 同时进行 =====

      const oldCP = recordChildPos(el);

      // 偷看：隐藏中文文字后测新高度和新子元素位置
      const cnNodes = el.querySelectorAll('.t-cn, .a-cn');
      cnNodes.forEach(n => n.style.display = 'none');
      const newCP = recordChildPos(el);
      const newHeights = new Map();
      el.querySelectorAll('.card').forEach(card => {
        if (card.dataset.uid) newHeights.set(card.dataset.uid, card.offsetHeight);
      });
      cnNodes.forEach(n => n.style.display = '');

      // 同时启动：文字淡出 + 高度收缩 + 子元素弹性上移
      cnNodes.forEach(node => {
        node.style.transition = 'opacity 300ms ease, transform 300ms ease';
        node.style.opacity = '0';
        node.style.transform = 'translateY(-8px)';
      });

      el.querySelectorAll('.card').forEach(card => {
        const uid = card.dataset.uid;
        const oldH = oldHeights.get(uid);
        const newH = newHeights.get(uid);

        // 高度弹性收缩（不清理，元素即将销毁）
        if (oldH != null && newH != null && Math.abs(newH - oldH) > 2) {
          card.style.height = oldH + 'px';
          void card.offsetHeight;
          card.style.transition = `height 400ms ${SPRING}`;
          card.style.height = newH + 'px';
        }

        // 子元素弹性上移（delta < 0 = 向上，不清理）
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
      }, 480);

    } else {
      // ===== 开启双语：高度弹性 + 中文文字淡入 + 子元素弹性下移 =====

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

      setTimeout(() => el.classList.remove('bilingual-anim'), 500);
    }

  } else {
    // 筛选变化：淡入淡出
    el.classList.remove('fade-in');
    const oldCards = el.querySelectorAll('.card');
    if (oldCards.length === 0) {
      el.innerHTML = html;
      el.classList.add('fade-in');
      return;
    }

    oldCards.forEach(c => {
      c.style.opacity = '0';
      c.style.transform = 'translateY(-6px)';
    });
    setTimeout(() => {
      el.innerHTML = html;
      el.classList.add('fade-in');
    }, 180);
  }
}

function showErr(err){
  const el = document.getElementById('list');
  if (el) el.innerHTML = `<pre>${escapeHtml(err.stack || String(err))}</pre>`;
  else console.error(err);
}

// 在 init() 完成后调用
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    init().catch(showErr);
    setupFabGroup();
  });
} else {
  init().catch(showErr);
  setupFabGroup();
}
