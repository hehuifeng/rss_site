/* Paper Tracker Service Worker
 * - 壳资源:precache + cache-first + 后台更新(离线可打开)
 * - 数据库(/rss_state.db[.gz]):cache-first 命中即回 + 6h 节流的后台校验(ETag 比对),
 *   有更新则替换缓存并 postMessage 通知页面显示「数据已更新」toast
 * - 其余请求(metrics API、外链)一律放行,绝不缓存
 * 注意:每次修改本文件必须 bump VERSION,否则客户端不会更新
 */
const VERSION = 'v2';
const SHELL_CACHE = `pt-shell-${VERSION}`;
const DB_CACHE = `pt-db-${VERSION}`;
const META_CACHE = `pt-meta-${VERSION}`; // 每个 URL 的上次 revalidate 时间戳
// 数据库 + sql.js 引擎文件(引擎现从 OSS 加载,同源 wasm 已不在壳内)
const DB_PATTERN = /\/(rss_state\.db(\.gz)?|sql-wasm\.wasm)$/;
const REVALIDATE_INTERVAL = 6 * 3600e3;

// 全部相对 sw.js 所在位置书写:GH Pages 项目页与自建域名共用同一份文件
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sql-wasm.js',
  './favicon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => ![SHELL_CACHE, DB_CACHE, META_CACHE].includes(k)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // metrics 上报等直接放行
  const url = new URL(req.url);
  if (DB_PATTERN.test(url.pathname)) { e.respondWith(handleDb(req, url)); return; }
  if (isShellRequest(req, url)) { e.respondWith(handleShell(req)); return; }
  // 其余放行:API、CDN 兜底、doi.org 外链等
});

function isShellRequest(req, url) {
  if (req.mode === 'navigate') return true;
  return url.origin === self.location.origin &&
         SHELL_ASSETS.some((a) => new URL(a, self.location.href).href === url.href);
}

async function handleShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const key = req.mode === 'navigate' ? new URL('./index.html', self.location.href).href : req;
  const cached = await cache.match(key, { ignoreSearch: true });
  const fresh = fetch(req)
    .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
    .catch(() => null);
  return cached || (await fresh) || Response.error();
}

async function handleDb(req, url) {
  const cache = await caches.open(DB_CACHE);
  const cached = await cache.match(url, { ignoreVary: true });
  if (cached) {
    revalidateInBackground(req, url, cache, cached); // 不 await:命中即回
    return cached;
  }
  // 未缓存:透传网络。失败必须原样抛出,由页面侧候选遍历切换下一数据源
  const res = await fetch(req);
  if (res.ok && res.status === 200) {
    try {
      await cache.put(url, res.clone());
    } catch (_) {
      await cache.delete(url).catch(() => {}); // 中断/部分响应:清理,避免脏缓存
    }
  }
  return res;
}

async function revalidateInBackground(req, url, cache, cached) {
  try {
    if (Date.now() - (await readMeta(url)) < REVALIDATE_INTERVAL) return;
    await writeMeta(url, Date.now());
    const fresh = await fetch(req, { cache: 'no-cache' });
    if (!fresh.ok) return;
    if (validatorsEqual(cached, fresh)) return; // 无变化:省掉 8.8MB 的缓存写入
    await cache.put(url, fresh);
    (await self.clients.matchAll({ type: 'window' }))
      .forEach((c) => c.postMessage({ type: 'PT_DB_UPDATED' }));
  } catch (_) { /* 离线或源不可达:静默保留旧缓存 */ }
}

function validatorsEqual(a, b) {
  for (const h of ['etag', 'last-modified', 'content-length']) {
    const va = a.headers.get(h), vb = b.headers.get(h);
    if (va != null && vb != null) return va === vb;
  }
  return false; // 无任何验证器可比对:宁可不更新也不错更
}

async function readMeta(url) {
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match(url.href);
    return r ? Number(await r.text()) || 0 : 0;
  } catch (_) { return 0; }
}

async function writeMeta(url, ts) {
  try {
    const c = await caches.open(META_CACHE);
    await c.put(url.href, new Response(String(ts)));
  } catch (_) { /* 忽略 */ }
}
