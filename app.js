// Patched for schema:
// articles(uid, feed_url, journal, title_en, title_cn, type, pub_date, doi,
//          article_url, abstract_en, abstract_cn, raw_jsonld, fetched_at, last_updated_at, topic_tag)

let db, SQL;
let PAGE = 1, PAGE_SIZE = 30;
let TOTAL_PAGES = 1;

const state = {
  bilingual: false,
};

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

// ===== 访问量（挂全局，避免未定义）=====
function trackVisits() {
  try {
    const LS = window.localStorage;
    const PV_KEY = 'pv_total';
    const UV_ID = 'uv_id';
    const UV_TOTAL = 'uv_total';

    const pv = Number(LS.getItem(PV_KEY) || '0') + 1;
    LS.setItem(PV_KEY, String(pv));

    if (!LS.getItem(UV_ID)) {
      LS.setItem(UV_ID, `${Date.now()}_${Math.random().toString(36).slice(2)}`);
      const uv = Number(LS.getItem(UV_TOTAL) || '0') + 1;
      LS.setItem(UV_TOTAL, String(uv));
    }
    const uv = Number(LS.getItem(UV_TOTAL) || '1');

    const bar = document.getElementById('site-stats');
    if (bar) bar.textContent = `本站访问量（本机统计）：浏览 ${pv} · 访客 ${uv}`;
  } catch (e) {
    console.warn('访问量统计失败：', e);
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
// ===== 入口 =====
async function init() {
  await ensureSqlJs();
  SQL = await initSqlJs({ locateFile });

  const res = await fetch('data/rss_state.db');
  const buf = await res.arrayBuffer();
  db = new SQL.Database(new Uint8Array(buf));

  await populateFilters();
  renderLastUpdated();  // ← 新增：显示“最近更新”
  bindEvents();
  window.trackVisits?.();
  runSearch();
}

// 回到顶部按钮逻辑
function setupBackToTop() {
  const btn = document.getElementById('back-to-top');
  if (!btn) return;

  // 显示/隐藏
  window.addEventListener('scroll', () => {
    if (document.documentElement.scrollTop > 200 || document.body.scrollTop > 200) {
      btn.style.display = 'block';
    } else {
      btn.style.display = 'none';
    }
  });

  // 点击平滑滚动到顶部
  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
  // types -> 渲染为按钮（可多选）
  const typeRows = query(`
    SELECT DISTINCT type AS t FROM articles
    WHERE t IS NOT NULL AND TRIM(t) <> ''
    ORDER BY t COLLATE NOCASE
  `);
  const typeContainer = document.getElementById('type-buttons');
  typeContainer.innerHTML = '';
  typeRows
    .map(r => r.t)
    .filter(Boolean)
    .forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'btn type-btn';
      btn.type = 'button';
      btn.textContent = t;
      btn.setAttribute('data-type', t);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        const pressed = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(pressed));
        btn.classList.toggle('is-active', pressed);
        PAGE = 1; runSearch();
      });
      typeContainer.appendChild(btn);
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
    btn.style.setProperty('--tag-bg', hashHsl(t));
    btn.setAttribute('data-tag', t);
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const pressed = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(pressed));
      btn.classList.toggle('is-active', pressed);
      PAGE = 1; runSearch();
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

  // 重置
  const reset = $('reset');
  if (reset) reset.onclick = () => {
    if (q) q.value = '';
    if (j) j.value = '';
    if (df) df.value = '';
    if (dt) dt.value = todayStr();   // 终止日期重置为今天
    // 清空 tag 按钮状态
    document.querySelectorAll('.tag-btn.is-active').forEach(b=>{
      b.classList.remove('is-active'); b.setAttribute('aria-pressed','false');
    });
    // 清空 type 按钮状态（新增）
    document.querySelectorAll('.type-btn.is-active').forEach(b=>{
      b.classList.remove('is-active'); b.setAttribute('aria-pressed','false');
    });
    PAGE = 1; runSearch();
  };

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
  const biBtn = $('bilingual-toggle');
  if (biBtn) {
    biBtn.addEventListener('click', () => {
      const now = biBtn.getAttribute('aria-pressed') !== 'true';
      state.bilingual = now;
      biBtn.setAttribute('aria-pressed', String(now));
      biBtn.textContent = '双语显示：' + (now ? '开' : '关');
      runSearch();
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

  // 3) 选中的类型（按钮式），OR 逻辑
  const selectedTypes = Array.from(document.querySelectorAll('.type-btn.is-active'))
    .map(b => b.getAttribute('data-type'))
    .filter(Boolean);

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


function runSearch() {
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

  document.getElementById('stats').textContent = `共 ${total} 条`;
  document.getElementById('pageinfo').textContent = `第 ${PAGE} 页`;
  document.getElementById('pagecount').textContent = ` / 共 ${totalPages} 页`;
  TOTAL_PAGES = totalPages; // 更新全局总页数
  render(rows, kw);
  document.getElementById('prev').disabled = PAGE <= 1;
  document.getElementById('next').disabled = (offset + rows.length) >= total;

  const gp = document.getElementById('goto-page');
  if (gp) gp.value = String(PAGE); // 可选：同步显示当前页
}

function render(items, kw) {
  const el = document.getElementById('list');
  el.innerHTML = items.map(it => {
    const tags = parseTags(it.topic_tag);
    const tagsHtml = tags.length
      ? `<div class="tags">` + tags.map(t => `
          <span class="tag-chip" style="--tag-bg:${hashHsl(t)}">${escapeHtml(t)}</span>
        `).join('') + `</div>`
      : '';

    const meta = [
      `<span><strong>期刊：</strong>${escapeHtml(it.journal || '')}</span>`,
      it.type ? `<span><strong>类型：</strong>${escapeHtml(it.type)}</span>` : '',
      // tags.length ? `<span><strong>tag：</strong>${tags.map(t => escapeHtml(t)).join(' / ')}</span>` : '',
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

    const doi = it.doi ? `<span class="badge">DOI</span> <a href="https://doi.org/${escapeHtml(it.doi)}" target="_blank" rel="noopener">${escapeHtml(it.doi)}</a>` : '';
    const link = it.article_url ? `<a href="${escapeHtml(it.article_url)}" target="_blank" rel="noopener">原文链接</a>` : '';

    return `
      <div class="card">
        ${titleHTML}
        ${tagsHtml}
        <div class="meta">${meta}</div>
        ${absHTML}
        <div class="meta">${doi} ${link}</div>
      </div>
    `;
  }).join('');
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
    setupBackToTop();
  });
} else {
  init().catch(showErr);
  setupBackToTop();
}
