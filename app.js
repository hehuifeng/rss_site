// Patched for schema:
// articles(uid, feed_url, journal, title_en, title_cn, type, pub_date, doi,
//          article_url, abstract_en, abstract_cn, raw_jsonld, fetched_at, last_updated_at, topic_tag)

let db, SQL;
let PAGE = 1, PAGE_SIZE = 30;

const state = {
  bilingual: false, // 双语显示开关
};

// self-contained: load local wasm by default; fallback to CDN if sql-wasm.js not loaded
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

function fmtDate(s){ if(!s) return ''; const m = /^(\d{4}-\d{2}-\d{2})/.exec(s); return m? m[1] : s; }
function escapeHtml(str){ return (str||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])) }
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 在字符串中高亮关键词（大小写不敏感，多词空格分隔）并保持 XSS 安全 */
function highlightAndEscape(text, kw){
  const s = String(text || '');
  const q = String(kw || '').trim();
  if (!q) return escapeHtml(s);

  // 把空白分隔的词合成一个正则
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return escapeHtml(s);
  const pattern = terms.map(escapeRegExp).join('|');
  const re = new RegExp(`(${pattern})`, 'gi');

  // 用哨兵包裹匹配，再整体转义，最后把哨兵替换成 <mark>
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

async function init() {
  await ensureSqlJs();
  SQL = await initSqlJs({ locateFile });

  const res = await fetch('data/rss_state.db');
  const buf = await res.arrayBuffer();
  db = new SQL.Database(new Uint8Array(buf));

  await populateFilters();
  bindEvents();
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
}

function bindEvents() {
  const $ = (id) => document.getElementById(id);

  // 搜索按钮：只按关键词触发
  $('search').onclick = () => { PAGE = 1; runSearch(); };

  // 关键词回车也触发
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); PAGE = 1; runSearch(); }
  });

  // 期刊/日期改变即筛选（无需点“搜索”）
  $('journal').addEventListener('change', () => { PAGE = 1; runSearch(); });
  $('date_from').addEventListener('change', () => { PAGE = 1; runSearch(); });
  $('date_to').addEventListener('change', () => { PAGE = 1; runSearch(); });

  // 重置
  $('reset').onclick = () => {
    $('q').value = '';
    $('journal').value = '';
    $('date_from').value = '';
    $('date_to').value = '';
    PAGE = 1; runSearch();
  };

  // 分页
  $('prev').onclick = () => { if (PAGE>1) { PAGE--; runSearch(); } };
  $('next').onclick = () => { PAGE++; runSearch(); };

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

  // 快捷时间按钮（近3天/近7天/近30天）
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => setQuickRange(btn.dataset.range));
  });
}

// 设置快捷时间区间并直接搜索
function setQuickRange(range) {
  const $ = (id) => document.getElementById(id);

  // 以“本地时区的今天”作为结束（包含当天）
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);

  if (range === '3d') {
    start.setDate(end.getDate() - 2);
  } else if (range === '7d') {
    start.setDate(end.getDate() - 6);
  } else if (range === '30d') {
    start.setDate(end.getDate() - 29);
  }

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

function buildWhere() {
  const kw = document.getElementById('q').value.trim();
  const journal = document.getElementById('journal').value;
  const df = document.getElementById('date_from').value;
  const dt = document.getElementById('date_to').value;

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

  const where = clauses.length ? ("WHERE " + clauses.join(" AND ")) : "";
  return { where, params, kw };
}

function runSearch() {
  const { where, params, kw } = buildWhere();

  const cntRow = query(`SELECT COUNT(*) AS n FROM articles ${where}`, params)[0];
  const total = cntRow ? cntRow.n : 0;

  const offset = (PAGE - 1) * PAGE_SIZE;

  // 取出双语字段，由 render 决定展示模式
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
    // 元信息：带“字段名”
    const meta = [
      `<span><strong>期刊：</strong>${escapeHtml(it.journal || '')}</span>`,
      it.type ? `<span><strong>类型：</strong>${escapeHtml(it.type)}</span>` : '',
      it.topic_tag ? `<span><strong>主题：</strong>${escapeHtml(it.topic_tag)}</span>` : '',
      `<span><strong>日期：</strong>${fmtDate(it.pub_date)}</span>`
    ].filter(Boolean).join(' · ');

    let titleHTML = '';
    let absHTML = '';

    if (state.bilingual) {
      // ✅ 英文在前，中文在后
      const ten = it.title_en ? `<div class="t-en">${highlightAndEscape(it.title_en, kw)}</div>` : '';
      const tcn = it.title_cn ? `<div class="t-cn">${highlightAndEscape(it.title_cn, kw)}</div>` : '';
      const aen = it.abstract_en ? `<div class="a-en">${highlightAndEscape(it.abstract_en, kw)}</div>` : '';
      const acn = it.abstract_cn ? `<div class="a-cn">${highlightAndEscape(it.abstract_cn, kw)}</div>` : '';

      const hasTitle = ten || tcn;
      titleHTML = `<div class="title">${hasTitle ? (ten + tcn) : '(无标题)'}</div>`;
      absHTML   = `<div class="abs">${aen}${acn}</div>`;
    } else {
      // 非双语：英文优先显示
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
        <div class="meta">${meta}</div>
        ${absHTML}
        <div class="meta">${doi} ${link}</div>
      </div>
    `;
  }).join('');
}

init().catch(err => {
  const el = document.getElementById('list');
  el.innerHTML = `<pre>${escapeHtml(err.stack || String(err))}</pre>`;
});
