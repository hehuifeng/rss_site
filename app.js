// Patched for schema:
// articles(uid, feed_url, journal, title_en, title_cn, type, pub_date, doi,
//          article_url, abstract_en, abstract_cn, raw_jsonld, fetched_at, last_updated_at, topic_tag)

let db, SQL;
let PAGE = 1, PAGE_SIZE = 30;

const state = {
  bilingual: false, // 双语显示开关
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

// ===== 工具函数 =====
function fmtDate(s){ if(!s) return ''; const m = /^(\d{4}-\d{2}-\d{2})/.exec(s); return m? m[1] : s; }
function escapeHtml(str){ return (str||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[m])) }
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 在字符串中高亮关键词（大小写不敏感，多词空格分隔）并保持 XSS 安全 */
function highlightAndEscape(text, kw){
  const s = String(text || '');
  const q = String(kw || '').trim();
  if (!q) return escapeHtml(s);
  const terms = q.split(/\s+/).filter(Boolean);
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

// 稳定标签颜色（HSL）——同一 tag 恒定颜色
function hashHsl(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 55 + (h % 20); // 55–74%
  const light = 46 + (h % 10); // 46–55%
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// 解析 topic_tag 字段为 tag 数组（支持中文逗号/英文逗号/分号/竖线/空白）
function parseTags(raw) {
  if (!raw) return [];
  return Array.from(
    new Set(
      String(raw)
        .split(/[,;｜|，；/]+|\s+/g)
        .map(t => t.trim())
        .filter(Boolean)
    )
  );
}

// ===== 入口 =====
async function init() {
  await ensureSqlJs();
  SQL = await initSqlJs({ locateFile });

  const res = await fetch('data/rss_state.db');
  const buf = await res.arrayBuffer();
  db = new SQL.Database(new Uint8Array(buf));

  await populateFilters();
  bindEvents();
  trackVisits(); // 记录访问量
  runSearch();
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

  // tags（从 topic_tag 聚合去重）
  const rows = query(`
    SELECT topic_tag FROM articles
    WHERE topic_tag IS NOT NULL AND TRIM(topic_tag) <> ''
  `);
  const all = new Set();
  rows.forEach(r => parseTags(r.topic_tag).forEach(t => all.add(t)));
  const tags = Array.from(all).sort((a,b)=>a.localeCompare(b,'zh-Hans-CN'));

  const selT = document.getElementById('tag');
  // 在多选里放一个“全部（清空选择）”提示项（disabled）
  const ph = document.createElement('option');
  ph.textContent = '（按住 Ctrl/⌘ 可多选；不选=全部）';
  ph.disabled = true;
  selT.appendChild(ph);

  tags.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    selT.appendChild(opt);
  });
}

// ===== 事件绑定（全改为即时触发 & 去掉搜索按钮）=====
function bindEvents() {
  const $ = (id) => document.getElementById(id);

  // 搜索按钮：只按关键词触发
  const searchBtn = $('search');
  if (searchBtn) searchBtn.onclick = () => { PAGE = 1; runSearch(); };

  // 关键词回车也触发
  const q = $('q');
  if (q) q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); PAGE = 1; runSearch(); }
  });

  // 期刊/日期改变即筛选
  const j = $('journal'); if (j) j.addEventListener('change', () => { PAGE = 1; runSearch(); });
  const df = $('date_from'); if (df) df.addEventListener('change', () => { PAGE = 1; runSearch(); });
  const dt = $('date_to');   if (dt) dt.addEventListener('change', () => { PAGE = 1; runSearch(); });

  // 重置
  const reset = $('reset');
  if (reset) reset.onclick = () => {
    if (q) q.value = '';
    if (j) j.value = '';
    if (df) df.value = '';
    if (dt) dt.value = '';
    PAGE = 1; runSearch();
  };

  // 分页
  const prev = $('prev'); if (prev) prev.onclick = () => { if (PAGE>1) { PAGE--; runSearch(); } };
  const next = $('next'); if (next) next.onclick = () => { PAGE++; runSearch(); };

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

// 设置快捷时间区间并直接搜索
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

// 读取筛选条件并构造 WHERE
function buildWhere() {
  const getVal = (id) => (document.getElementById(id)?.value ?? '').trim();

  const kw = getVal('q');
  const journal = getVal('journal');
  const df = getVal('date_from');
  const dt = getVal('date_to');

  const clauses = [];
  const params = {};

  if (kw) {
    clauses.push("(" +
      "title_en LIKE :kw OR title_cn LIKE :kw OR " +
      "abstract_en LIKE :kw OR abstract_cn LIKE :kw OR " +
      "doi LIKE :kw" +
    ")");
    params[":kw"] = `%${kw}%`;
  }
  if (journal) {
    clauses.push("journal = :journal");
    params[":journal"] = journal;
  }
  if (df) { clauses.push("(pub_date >= :df)"); params[":df"] = df; }
  if (dt) { clauses.push("(pub_date <= :dt)"); params[":dt"] = dt; }

  // tag 过滤：每个被选中的 tag 都需要在 topic_tag 中出现（AND）
  selectedTags.forEach((t, i) => {
    const key = `:tg${i}`;
    clauses.push(`(topic_tag LIKE ${key})`);
    params[key] = `%${t}%`;
  });

  const where = clauses.length ? ("WHERE " + clauses.join(" AND ")) : "";
  return { where, params, kw, selectedTags };
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

  document.getElementById('stats').textContent = `共 ${total} 条 · 当前第 ${PAGE} 页`;
  document.getElementById('pageinfo').textContent = `第 ${PAGE} 页`;

  render(rows, kw);
  document.getElementById('prev').disabled = PAGE <= 1;
  document.getElementById('next').disabled = (offset + rows.length) >= total;
}

function render(items, kw) {
  const el = document.getElementById('list');
  el.innerHTML = items.map(it => {
    // tag chips
    const tags = parseTags(it.topic_tag);
    const tagsHtml = tags.length
      ? `<div class="tags">` + tags.map(t => `
          <span class="tag-chip" style="--tag-bg:${hashHsl(t)}">${escapeHtml(t)}</span>
        `).join('') + `</div>`
      : '';

    // 元信息：字段名
    const meta = [
      `<span><strong>期刊：</strong>${escapeHtml(it.journal || '')}</span>`,
      it.type ? `<span><strong>类型：</strong>${escapeHtml(it.type)}</span>` : '',
      tags.length ? `<span><strong>tag：</strong>${tags.map(t => escapeHtml(t)).join(' / ')}</span>` : '',
      `<span><strong>日期：</strong>${fmtDate(it.pub_date)}</span>`
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

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => init().catch(showErr));
} else {
  init().catch(showErr);
}
