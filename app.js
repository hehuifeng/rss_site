// ====== Paper Tracker (Fast first paint + Local full-cache + Single-select tags + Real PV/UV) ======

let PAGE = 1;
let PAGE_SIZE = 30;
let TOTAL = 0;
let TOTAL_PAGES = 1;

const state = {
  bilingual: false,
  filtersLoaded: false,
  selectedTag: null,          // 单选 tag（互斥）
  allReady: false,            // IndexedDB 是否已有全量
  allPapers: null,            // 内存缓存（提升速度）
  lastUpdatedAt: null,        // 服务器 last_updated_at（来自 /api/filters 或 /api/papers）
};

function $(id){ return document.getElementById(id); }

// ------------------------ utils ------------------------
function escapeHtml(str){
  return (str||'').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[m]));
}

function fmtDate(s){
  if(!s) return '';
  const m=/^(\d{4}-\d{2}-\d{2})/.exec(String(s));
  return m?m[1]:String(s);
}

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

function highlightAndEscape(text, kw){
  const s = String(text || '');
  const q = String(kw || '').trim();
  if (!q) return escapeHtml(s);
  const terms = q.split(/[,\s]+/).filter(Boolean);
  if (!terms.length) return escapeHtml(s);
  const pattern = terms.map(escapeRegExp).join('|');
  const re = new RegExp(`(${pattern})`, 'gi');
  const marked = s.replace(re, '[[[H]]]' + '$1' + '[[[/H]]]');
  let esc = escapeHtml(marked);
  esc = esc.replace(/\[\[\[H\]\]\]/g, '<mark>').replace(/\[\[\[\/H\]\]\]/g, '</mark>');
  return esc;
}

function debounce(fn, wait=200){
  let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn.apply(null,args), wait); };
}

function todayStr(){
  const d=new Date();
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const da=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

function setDefaultDatesOnce(){
  const dt = $('date_to');
  if (dt && !dt.value) dt.value = todayStr();
}

// ------------------------ tag colors ------------------------
function hashHsl(tag){
  let h=0;
  for(let i=0;i<tag.length;i++) h=(h*31+tag.charCodeAt(i))>>>0;
  const hue=h%360;
  const sat=55+(h%20);
  const light=46+(h%10);
  // 注意：你 CSS 里使用的是 `hsl(h s% l%)` 这种新写法；我们也按同样格式返回
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function lightenHsl(hslStr, delta = 45) {
  // 支持：hsl(210 60% 50%) 形式
  const m = /hsl\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)/i.exec(hslStr);
  if (!m) return hslStr;
  const hue = Number(m[1]);
  const sat = Number(m[2]);
  const light = Number(m[3]);
  const nl = Math.min(95, Math.max(0, Math.round(light + delta)));
  return `hsl(${hue} ${sat}% ${nl}%)`;
}

function getTagColors(tag) {
  const active = hashHsl(tag);
  const inactive = lightenHsl(active, 45);
  return { active, inactive };
}

// ------------------------ parse tags ------------------------
function parseTags(raw){
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(x=>String(x).trim()).filter(Boolean);
  const s = String(raw).trim();
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
    try {
      const parsed = JSON.parse(s);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return Array.from(new Set(arr.map(x=>String(x).trim()).filter(Boolean)));
    } catch {}
  }
  return Array.from(new Set(
    s.split(/[,;｜|，；/]+|\s+/g).map(t=>t.replace(/^"+|"+$/g,'').trim()).filter(Boolean)
  ));
}

// ------------------------ IndexedDB (KV store) ------------------------
const DB_NAME = 'paper_tracker';
const DB_VER  = 1;
const STORE   = 'kv';

function idbOpen(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE,'readonly');
    const st = tx.objectStore(STORE);
    const req = st.get(key);
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function idbSet(key, val){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE,'readwrite');
    const st = tx.objectStore(STORE);
    const req = st.put(val, key);
    req.onsuccess = ()=> resolve(true);
    req.onerror = ()=> reject(req.error);
  });
}

// ------------------------ UI helpers ------------------------
function updateBilingualButton(){
  const biFloatBtn = $('bilingual-toggle-float');
  if (biFloatBtn) biFloatBtn.textContent = '双语显示：' + (state.bilingual ? '开' : '关');
  const biBtn = $('bilingual-toggle');
  if (biBtn) {
    biBtn.textContent = '双语显示：' + (state.bilingual ? '开' : '关');
    biBtn.setAttribute('aria-pressed', String(state.bilingual));
  }
}

function renderSkeleton(msg='加载中…'){
  const el=$('list'); if(!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="title">${escapeHtml(msg)}</div>
      <div class="meta">正在加载数据…</div>
    </div>
  `;
}

function showErr(err){
  const el=$('list');
  if (el) el.innerHTML = `<pre>${escapeHtml(err?.stack || String(err))}</pre>`;
  else console.error(err);
}

// ------------------------ API with AbortController ------------------------
let currentAbort = null;

async function apiGetJson(path, {signal} = {}){
  const res = await fetch(path, {
    headers: {'Accept':'application/json'},
    cache: 'no-cache',
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`HTTP ${res.status}: ${path}\n${text.slice(0,300)}`);
  }
  return await res.json();
}

function buildQueryParams(){
  const kwRaw = ($('q')?.value ?? '').trim();
  const journal = ($('journal')?.value ?? '').trim();
  const df = ($('date_from')?.value ?? '').trim();
  const dt = ($('date_to')?.value ?? '').trim();
  const type = ($('type-selector')?.value ?? '').trim();
  const tag  = state.selectedTag;

  const params = new URLSearchParams();
  params.set('page', String(PAGE));
  params.set('page_size', String(PAGE_SIZE));
  if (kwRaw) params.set('q', kwRaw);
  if (journal) params.set('journal', journal);
  if (df) params.set('date_from', df);
  if (dt) params.set('date_to', dt);
  if (type) params.set('type', type);
  if (tag) params.set('tags', tag); // 后端如果支持 tags=xxx
  return { params, kwRaw, journal, df, dt, type, tag };
}

// ------------------------ render list ------------------------
function render(items, kw){
  const el = $('list');
  if (!el) return;

  el.innerHTML = (items || []).map(it=>{
    const tags = parseTags(it.topic_tag);
    const tagsHtml = tags.length
      ? `<div class="tags">` + tags.map(t=>`
          <span class="tag-chip" style="--tag-bg:${hashHsl(t)}">${escapeHtml(t)}</span>
        `).join('') + `</div>`
      : '';

    const meta = [
      `<span><strong>期刊：</strong>${escapeHtml(it.journal || '')}</span>`,
      it.type ? `<span><strong>类型：</strong>${escapeHtml(it.type)}</span>` : '',
      `<span><strong>发表日期：</strong>${fmtDate(it.pub_date)}</span>`
    ].filter(Boolean).join(' · ');

    let titleHTML='', absHTML='';
    if (state.bilingual) {
      const ten = it.title_en ? `<div class="t-en">${highlightAndEscape(it.title_en, kw)}</div>` : '';
      const tcn = it.title_cn ? `<div class="t-cn">${highlightAndEscape(it.title_cn, kw)}</div>` : '';
      const aen = it.abstract_en ? `<div class="a-en">${highlightAndEscape(it.abstract_en, kw)}</div>` : '';
      const acn = it.abstract_cn ? `<div class="a-cn">${highlightAndEscape(it.abstract_cn, kw)}</div>` : '';
      titleHTML = `<div class="title">${(ten||tcn) ? (ten+tcn) : '(无标题)'}</div>`;
      absHTML = `<div class="abs">${aen}${acn}</div>`;
    } else {
      const titlePref = it.title_en || it.title_cn || '(无标题)';
      const absPref = it.abstract_en || it.abstract_cn || '';
      titleHTML = `<div class="title">${highlightAndEscape(titlePref, kw)}</div>`;
      absHTML = absPref ? `<div class="abs">${highlightAndEscape(absPref, kw)}</div>` : '';
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

// ------------------------ Filters rendering ------------------------
function sortTags(tags){
  tags.sort((a,b)=>{
    if (a === '生命科学') return -1;
    if (b === '生命科学') return 1;
    if (a === '其他') return 1;
    if (b === '其他') return -1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });
  return tags;
}

function clearSelectKeepFirst(selectEl){
  if (!selectEl) return;
  while (selectEl.children.length > 1) selectEl.removeChild(selectEl.lastChild);
}

function setBtnVisual(btn, pressed){
  const t = (btn.dataset.tag || btn.textContent || '').trim();
  const {active, inactive} = getTagColors(t);
  btn.style.setProperty('--tag-bg', active);
  btn.style.setProperty('--tag-bg-light', inactive);

  // ✅ 兜底：直接写背景色，确保一定有颜色
  btn.style.backgroundColor = pressed ? active : inactive;
  btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  btn.classList.toggle('is-active', pressed);
}

function bindTagButtonSingleSelect(btn){
  if (btn.__boundTag) return;
  btn.__boundTag = true;

  btn.addEventListener('click', ()=>{
    const t = (btn.dataset.tag || btn.textContent || '').trim();
    const isPressed = btn.getAttribute('aria-pressed') === 'true';

    // 规则：再点一次同一个 -> 取消过滤
    if (isPressed) {
      state.selectedTag = null;
      document.querySelectorAll('.tag-btn').forEach(b=>setBtnVisual(b,false));
    } else {
      state.selectedTag = t;
      document.querySelectorAll('.tag-btn').forEach(b=>{
        const bt = (b.dataset.tag || b.textContent || '').trim();
        setBtnVisual(b, bt === t);
      });
    }

    PAGE = 1;
    fetchPapersPage().catch(showErr);
  });
}

function paintAndBindExistingTagButtons(){
  const btns = Array.from(document.querySelectorAll('.tag-btn'));
  if (!btns.length) return;

  btns.forEach(btn=>{
    // 默认未按下
    if (!btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed','false');
    setBtnVisual(btn, btn.getAttribute('aria-pressed') === 'true');
    bindTagButtonSingleSelect(btn);
  });
}

function renderTagButtons(tags){
  const container = $('tag-buttons');
  if (!container) return;

  container.innerHTML = '';
  sortTags(tags).forEach(t=>{
    const btn = document.createElement('button');
    btn.className = 'btn tag-btn';
    btn.type = 'button';
    btn.textContent = t;
    btn.dataset.tag = t;
    btn.setAttribute('aria-pressed','false');

    // 设置颜色 + 绑定单选互斥
    setBtnVisual(btn, false);
    bindTagButtonSingleSelect(btn);

    container.appendChild(btn);
  });
}

async function loadFilters(){
  if (state.filtersLoaded) return;

  try{
    const data = await apiGetJson('/api/filters');
    state.lastUpdatedAt = data.last_updated_at || state.lastUpdatedAt || null;

    // journals
    clearSelectKeepFirst($('journal'));
    (data.journals||[]).forEach(({name})=>{
      const opt=document.createElement('option');
      opt.value=name; opt.textContent=name;
      $('journal')?.appendChild(opt);
    });

    // types
    clearSelectKeepFirst($('type-selector'));
    (data.types||[]).forEach(({name})=>{
      const opt=document.createElement('option');
      opt.value=name; opt.textContent=name;
      $('type-selector')?.appendChild(opt);
    });

    // tags
    renderTagButtons((data.tags||[]).map(x=>x.name).filter(Boolean));

    // db updated bar
    if ($('db-updated')) {
      const ts = data.last_updated_at ? String(data.last_updated_at).replace('T',' ').slice(0,16) : '—';
      $('db-updated').textContent = `数据库共 ${data.total ?? ''} 条 · 最近更新：${ts}`;
    }

    state.filtersLoaded = true;
  }catch(e){
    console.warn('filters 加载失败（不影响使用）：', e);
    state.filtersLoaded = true;
  }
}

// ------------------------ Local full-cache: load + background download (daily max once) ------------------------
async function loadLocalAllIntoMemory(){
  // 读 IDB -> 内存（避免每次都查 IDB）
  try{
    const all = await idbGet('papers_all');
    if (Array.isArray(all) && all.length) {
      state.allPapers = all;
      state.allReady = true;
      return true;
    }
  } catch(e){
    console.warn('读取本地全量失败：', e);
  }
  return false;
}

function kwTerms(kwRaw){
  const terms = String(kwRaw || '').trim().split(/[,\s]+/).filter(Boolean);
  return terms.map(s=>s.toLowerCase());
}

function localFilter(all, {kwRaw, journal, df, dt, type, tag}){
  const terms = kwTerms(kwRaw);
  const hasKw = terms.length > 0;

  return all.filter(it=>{
    if (journal && it.journal !== journal) return false;
    if (type && it.type !== type) return false;

    const pd = fmtDate(it.pub_date || '');
    if (df && pd && pd < df) return false;
    if (dt && pd && pd > dt) return false;

    if (tag) {
      const tags = parseTags(it.topic_tag);
      if (!tags.includes(tag)) return false;
    }

    if (hasKw) {
      const hay = `${it.title_en||''} ${it.title_cn||''} ${it.abstract_en||''} ${it.abstract_cn||''} ${it.doi||''}`.toLowerCase();
      for (const t of terms) if (!hay.includes(t)) return false;
    }

    return true;
  });
}

async function localQueryAndRender(){
  if (!state.allReady || !Array.isArray(state.allPapers)) return false;

  const { kwRaw, journal, df, dt, type, tag } = buildQueryParams();

  // 过滤
  const filtered = localFilter(state.allPapers, {kwRaw, journal, df, dt, type, tag});

  // 分页
  TOTAL = filtered.length;
  TOTAL_PAGES = Math.max(1, Math.ceil(TOTAL / PAGE_SIZE));
  PAGE = Math.max(1, Math.min(PAGE, TOTAL_PAGES));

  const start = (PAGE-1)*PAGE_SIZE;
  const items = filtered.slice(start, start + PAGE_SIZE);

  // stats
  if ($('stats')) $('stats').textContent = `共 ${TOTAL} 条`;
  if ($('pageinfo')) $('pageinfo').textContent = `第 ${PAGE} 页`;
  if ($('pagecount')) $('pagecount').textContent = ` / 共 ${TOTAL_PAGES} 页`;

  // db updated
  const localTs = await idbGet('papers_last_updated_at').catch(()=>null);
  if ($('db-updated') && localTs) {
    const ts = String(localTs).replace('T',' ').slice(0,16);
    $('db-updated').textContent = `数据库共 ${TOTAL} 条 · 最近更新：${ts}`;
  }

  render(items, kwRaw);

  if ($('prev')) $('prev').disabled = PAGE <= 1;
  if ($('next')) $('next').disabled = PAGE >= TOTAL_PAGES;
  const gp = $('goto-page'); if (gp) gp.value = String(PAGE);

  return true;
}

async function downloadAllPapersInBackgroundDailyMax(){
  // 避免重复进入
  if (downloadAllPapersInBackgroundDailyMax._running) return;
  downloadAllPapersInBackgroundDailyMax._running = true;

  try{
    // “每天最多下载一次”
    const today = todayStr();
    const lastSyncDay = await idbGet('papers_last_sync_day').catch(()=>null);
    if (lastSyncDay === today) return;

    // 如果本地没有全量，也要下（即便今天已经同步过也不会发生，因为 lastSyncDay==today 会 return）
    // 先取一下服务器 last_updated_at（用 /api/filters 最省）
    let serverMeta = null;
    try{
      serverMeta = await apiGetJson('/api/filters');
    }catch(e){
      // filters 挂了也不影响主功能，这里就不下载全量
      console.warn('获取服务器 meta 失败：', e);
      return;
    }

    const serverTs = serverMeta.last_updated_at || null;
    const localTs  = await idbGet('papers_last_updated_at').catch(()=>null);

    // 如果本地已有全量，并且 serverTs == localTs，那今天就不必重下（但仍写 lastSyncDay 防止重复）
    if (state.allReady && localTs && serverTs && localTs === serverTs) {
      await idbSet('papers_last_sync_day', today);
      return;
    }

    // 分页拉全量（注意：这是后台动作，不阻塞 UI）
    const pageSize = 1000;
    let page = 1;
    let all = [];
    let total = Infinity;

    while(all.length < total){
      const data = await apiGetJson(`/api/papers?page=${page}&page_size=${pageSize}`);
      const items = data.items || [];
      total = Number(data.total ?? (all.length + items.length));
      all = all.concat(items);
      page += 1;

      if (items.length === 0) break;
      // 让浏览器喘气：避免卡 UI
      await new Promise(r=>setTimeout(r, 0));
    }

    if (all.length) {
      await idbSet('papers_all', all);
      if (serverTs) await idbSet('papers_last_updated_at', serverTs);
      await idbSet('papers_last_sync_day', today);

      // 更新内存缓存：后续点击立刻“本地化”
      state.allPapers = all;
      state.allReady  = true;
    }
  } finally {
    downloadAllPapersInBackgroundDailyMax._running = false;
  }
}

// ------------------------ Remote fallback: server page fetch ------------------------
async function fetchPapersPageRemote(){
  const { params, kwRaw } = buildQueryParams();
  const url = `/api/papers?${params.toString()}`;

  // 取消上一个请求，避免连点卡顿
  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();

  renderSkeleton('正在加载…');

  const data = await apiGetJson(url, {signal: currentAbort.signal});
  const items = data.items || [];
  TOTAL = Number(data.total ?? items.length ?? 0);
  TOTAL_PAGES = Math.max(1, Math.ceil(TOTAL / PAGE_SIZE));

  if ($('stats')) $('stats').textContent = `共 ${TOTAL} 条`;
  if ($('pageinfo')) $('pageinfo').textContent = `第 ${PAGE} 页`;
  if ($('pagecount')) $('pagecount').textContent = ` / 共 ${TOTAL_PAGES} 页`;

  if (data.last_updated_at && $('db-updated')) {
    const ts = String(data.last_updated_at).replace('T',' ').slice(0,16);
    $('db-updated').textContent = `数据库共 ${TOTAL} 条 · 最近更新：${ts}`;
    state.lastUpdatedAt = data.last_updated_at;
  }

  render(items, kwRaw);

  if ($('prev')) $('prev').disabled = PAGE <= 1;
  if ($('next')) $('next').disabled = PAGE >= TOTAL_PAGES;
  const gp = $('goto-page'); if (gp) gp.value = String(PAGE);
}

async function fetchPapersPage(){
  // ✅ 优先本地
  const ok = await localQueryAndRender();
  if (ok) return;

  // ❌ 本地还没全量：走后端分页
  await fetchPapersPageRemote();
}

// ------------------------ Real PV/UV (requires backend) ------------------------
function getOrCreateUvId(){
  try{
    const LS = window.localStorage;
    const k = 'paper_uv_id';
    let v = LS.getItem(k);
    if (!v) {
      v = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      LS.setItem(k, v);
    }
    return v;
  }catch{
    return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

async function trackVisitsReal(){
  const bar = $('site-stats');
  const uv_id = getOrCreateUvId();

  // 真实计数：需要后端提供 /api/metrics/visit
  try{
    const res = await fetch('/api/metrics/visit', {
      method: 'POST',
      headers: {'Content-Type':'application/json', 'Accept':'application/json'},
      body: JSON.stringify({ uv_id }),
      cache: 'no-cache'
    });
    if (!res.ok) throw new Error(`metrics HTTP ${res.status}`);
    const data = await res.json();

    // 期望返回：{ pv_total: number, uv_total: number }
    const pv = Number(data.pv_total ?? 0);
    const uv = Number(data.uv_total ?? 0);

    if (bar) bar.textContent = `本站访问量：浏览 ${pv} · 访客 ${uv}`;
    return;
  }catch(e){
    // fallback：本机统计（假的）
    try{
      const LS = window.localStorage;
      const PV_KEY = 'pv_total_local';
      const UV_KEY = 'uv_total_local';

      const pv = Number(LS.getItem(PV_KEY) || '0') + 1;
      LS.setItem(PV_KEY, String(pv));

      let uv = Number(LS.getItem(UV_KEY) || '0');
      // uv 用 uv_id 是否首次生成来决定，这里简单处理：如果没有 uv_mark 则 +1
      const UV_MARK = 'uv_marked';
      if (!LS.getItem(UV_MARK)) { LS.setItem(UV_MARK,'1'); uv += 1; LS.setItem(UV_KEY, String(uv)); }

      if (bar) bar.textContent = `本站访问量（本机统计，非真实）：浏览 ${pv} · 访客 ${uv}`;
    }catch{}
  }
}

// ------------------------ events ------------------------
function bindEvents(){
  const q=$('q');
  if (q){
    const debounced = debounce(()=>{ PAGE=1; fetchPapersPage().catch(showErr); }, 200);
    q.addEventListener('input', debounced);
    q.addEventListener('keydown', (e)=>{ if(e.key==='Enter') e.preventDefault(); });
  }

  const j=$('journal'); if (j) j.addEventListener('change', ()=>{ PAGE=1; fetchPapersPage().catch(showErr); });
  const df=$('date_from'); if (df) df.addEventListener('change', ()=>{ PAGE=1; fetchPapersPage().catch(showErr); });
  const dt=$('date_to'); if (dt) dt.addEventListener('change', ()=>{ PAGE=1; fetchPapersPage().catch(showErr); });

  const ty=$('type-selector'); if (ty) ty.addEventListener('change', ()=>{ PAGE=1; fetchPapersPage().catch(showErr); });

  const reset=$('reset');
  if (reset) reset.onclick=()=>{
    if (q) q.value='';
    if (j) j.value='';
    if (df) df.value='';
    if (dt) dt.value=todayStr();
    if (ty) ty.value='';

    // 清 tag（互斥）
    state.selectedTag = null;
    document.querySelectorAll('.tag-btn').forEach(b=>setBtnVisual(b,false));

    PAGE=1; fetchPapersPage().catch(showErr);
  };

  const prev=$('prev'), next=$('next');
  if (prev) prev.onclick=()=>{
    if (PAGE>1){ PAGE--; fetchPapersPage().catch(showErr); window.scrollTo({top:0,behavior:'smooth'}); }
  };
  if (next) next.onclick=()=>{
    if (PAGE<TOTAL_PAGES){ PAGE++; fetchPapersPage().catch(showErr); window.scrollTo({top:0,behavior:'smooth'}); }
  };

  const gotoInput=$('goto-page'), gotoBtn=$('goto-btn');
  const go=()=>{
    const num = Number((gotoInput?.value||'').trim());
    if (!Number.isFinite(num)) return;
    const target = Math.max(1, Math.min(TOTAL_PAGES, Math.floor(num)));
    if (target!==PAGE){ PAGE=target; fetchPapersPage().catch(showErr); window.scrollTo({top:0,behavior:'smooth'}); }
  };
  if (gotoBtn) gotoBtn.onclick=go;
  if (gotoInput) gotoInput.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); go(); } });

  const biBtn=$('bilingual-toggle');
  if (biBtn) biBtn.addEventListener('click', ()=>{
    state.bilingual=!state.bilingual;
    updateBilingualButton();
    fetchPapersPage().catch(showErr);
  });

  const biFloat=$('bilingual-toggle-float');
  if (biFloat) biFloat.addEventListener('click', ()=>{
    state.bilingual=!state.bilingual;
    updateBilingualButton();
    fetchPapersPage().catch(showErr);
  });

  document.querySelectorAll('.range-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const range = btn.dataset.range;
      const now=new Date();
      const end=new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const start=new Date(end);
      if (range==='3d') start.setDate(end.getDate()-2);
      else if (range==='7d') start.setDate(end.getDate()-6);
      else if (range==='30d') start.setDate(end.getDate()-29);

      const fmt=(d)=>{
        const y=d.getFullYear();
        const m=String(d.getMonth()+1).padStart(2,'0');
        const da=String(d.getDate()).padStart(2,'0');
        return `${y}-${m}-${da}`;
      };
      $('date_from').value=fmt(start);
      $('date_to').value=fmt(end);
      PAGE=1; fetchPapersPage().catch(showErr);
    });
  });
}

function setupBackToTop(){
  const btn=$('back-to-top');
  if(!btn) return;
  window.addEventListener('scroll', ()=>{
    if(document.documentElement.scrollTop>200||document.body.scrollTop>200) btn.style.display='block';
    else btn.style.display='none';
  });
  btn.addEventListener('click', ()=>window.scrollTo({top:0,behavior:'smooth'}));
}

// ------------------------ init ------------------------
async function init(){
  setDefaultDatesOnce();
  updateBilingualButton();

  // ✅ 先把 HTML 里已有的 tag（如果你写死了 3 个按钮）上色并绑定
  paintAndBindExistingTagButtons();

  bindEvents();
  setupBackToTop();

  // ✅ 真实 PV/UV（需后端）
  trackVisitsReal().catch(()=>{});

  // ✅ 先尝试加载本地全量 -> 有就秒开
  const hasLocalAll = await loadLocalAllIntoMemory();

  if (hasLocalAll) {
    PAGE = 1;
    await localQueryAndRender();
  } else {
    // 没有全量：先拉第一页，保证首屏可用
    PAGE = 1;
    await fetchPapersPageRemote();
  }

  // ✅ 并行加载 filters（不阻塞首屏）
  loadFilters().catch(()=>{});

  // ✅ 后台：每天最多下载一次全量，完成后后续点击全部走本地
  downloadAllPapersInBackgroundDailyMax().catch(()=>{});
}

if (document.readyState==='loading'){
  window.addEventListener('DOMContentLoaded', ()=>{ init().catch(showErr); });
}else{
  init().catch(showErr);
}
