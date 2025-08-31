
// Patched for schema:
// articles(uid, feed_url, journal, title_en, title_cn, type, pub_date, doi,
//          article_url, abstract_en, abstract_cn, raw_jsonld, fetched_at, last_updated_at, topic_tag)

let db, SQL;
let PAGE = 1, PAGE_SIZE = 30;

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
  document.getElementById('search').onclick = () => { PAGE = 1; runSearch(); };
  document.getElementById('reset').onclick = () => {
    document.getElementById('q').value = '';
    document.getElementById('journal').value = '';
    document.getElementById('lang').value = '';
    document.getElementById('date_from').value = '';
    document.getElementById('date_to').value = '';
    PAGE = 1; runSearch();
  };
  document.getElementById('prev').onclick = () => { if (PAGE>1) { PAGE--; runSearch(); } };
  document.getElementById('next').onclick = () => { PAGE++; runSearch(); };
}

function buildWhere() {
  const kw = document.getElementById('q').value.trim();
  const journal = document.getElementById('journal').value;
  const lang = document.getElementById('lang').value; // zh/en/'' 仅控制展示，不做过滤
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
  if (dt) { clauses.push("(pub_date <= :dt || 'T23:59:59')"); params[":dt"] = dt; }

  const where = clauses.length ? ("WHERE " + clauses.join(" AND ")) : "";
  return { where, params, lang };
}

function runSearch() {
  const { where, params, lang } = buildWhere();

  const cntRow = query(`SELECT COUNT(*) AS n FROM articles ${where}`, params)[0];
  const total = cntRow ? cntRow.n : 0;

  const offset = (PAGE - 1) * PAGE_SIZE;

  // 统一在 SQL 层构造展示字段（title/abstract 优先中文，其次英文）
  const rows = query(`
    SELECT
      uid,
      journal,
      pub_date,
      doi,
      article_url,
      COALESCE(NULLIF(TRIM(title_cn),''), title_en, '') AS title,
      CASE
        WHEN :lang = 'zh' THEN COALESCE(NULLIF(TRIM(abstract_cn),''), abstract_en, '')
        WHEN :lang = 'en' THEN COALESCE(NULLIF(TRIM(abstract_en),''), abstract_cn, '')
        ELSE COALESCE(NULLIF(TRIM(abstract_cn),''), abstract_en, '')
      END AS abs
    FROM articles
    ${where}
    ORDER BY pub_date DESC, uid DESC
    LIMIT :limit OFFSET :offset
  `, { ...params, ":limit": PAGE_SIZE, ":offset": offset, ":lang": lang });

  document.getElementById('stats').textContent = `共 ${total} 条 · 当前第 ${PAGE} 页`;
  document.getElementById('pageinfo').textContent = `第 ${PAGE} 页`;

  render(rows);
  document.getElementById('prev').disabled = PAGE <= 1;
  document.getElementById('next').disabled = (offset + rows.length) >= total;
}

function render(items) {
  const el = document.getElementById('list');
  el.innerHTML = items.map(it => {
    const t = escapeHtml(it.title || '');
    const meta = [escapeHtml(it.journal || ''), fmtDate(it.pub_date)].filter(Boolean).join(' · ');
    const abs = escapeHtml(it.abs || '');
    const doi = it.doi ? `<span class="badge">DOI</span> <a href="https://doi.org/${escapeHtml(it.doi)}" target="_blank" rel="noopener">${escapeHtml(it.doi)}</a>` : '';
    const link = it.article_url ? `<a href="${escapeHtml(it.article_url)}" target="_blank" rel="noopener">原文链接</a>` : '';
    return `
      <div class="card">
        <div class="title">${t}</div>
        <div class="meta">${meta}</div>
        <div class="abs">${abs}</div>
        <div class="meta">${doi} ${link}</div>
      </div>
    `;
  }).join('');
}

init().catch(err => {
  const el = document.getElementById('list');
  el.innerHTML = `<pre>${escapeHtml(err.stack || String(err))}</pre>`;
});
