// POC adapter: presents AEM Page Management as the DA admin API on localhost:8787.
// Read-only. Run: AEMCS_TOKEN_FILE=... node tools/aemcs-shim/server.mjs
// Every request is logged; the unhandled ones are the measured list of EW's DA dependencies.
import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { tree2html, KEY_VALUE } from './tree2html.mjs';
import { roundTrip, mainOf, units, signature, ownerMap, buildPatch, MODELS } from './patch.mjs';

const HOST = process.env.AEMCS_HOST;
const API = `${HOST}/adobe/experimental/aspm-expires-20251231`;
const SITE_ID = process.env.AEMCS_SITE;
if (!HOST || !SITE_ID) throw new Error('Set AEMCS_HOST and AEMCS_SITE');
const ORG = process.env.AEMCS_ORG ?? 'aem-showcase';
const REPO = process.env.AEMCS_REPO ?? 'frescopa';
const ROOT_PATH = process.env.AEMCS_ROOT ?? '/en';
const SELF = 'http://localhost:8787';
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'https://aemcspoc--da-live--adobe.aem.live',
  'https://aemcspoc--da-live--adobe.aem.page',
  ...(process.env.AEMCS_ORIGINS ?? '').split(',').filter(Boolean),
]);
const LOG = process.env.AEMCS_LOG ?? '/dev/null';
const PATCH_LOG = process.env.AEMCS_PATCH_LOG ?? '/dev/null';
// Dry run: saves are converted to JSON Patch and logged. Nothing here sends them to AEM.
const DRY_RUN = process.env.AEMCS_DRY_RUN === '1';
// Real writes are locked to this one page id; every other page stays read-only.
const WRITE_PAGES = new Set((process.env.AEMCS_WRITE_PAGE ?? '').split(',').filter(Boolean));
const actionsFor = (id) => (WRITE_PAGES.has(id) ? 'read,write' : 'read');
const sessions = new Map();
const token = () => readFileSync(process.env.AEMCS_TOKEN_FILE, 'utf8').trim();

const defs = await (await fetch(`https://main--${REPO}--${ORG}.aem.page/component-definition.json`)).json();
defs.groups.forEach((g) => g.components.forEach((c) => {
  const t = c.plugins?.xwalk?.page?.template;
  if (t?.['key-value']) KEY_VALUE.add(t.model ?? c.id);
}));

const models = await (await fetch(`https://main--${REPO}--${ORG}.aem.page/component-models.json`)).json();
models.forEach((m) => MODELS.set(m.id, Object.fromEntries((m.fields ?? []).map((f) => [f.name, f.component]))));

const aem = async (path, params) => {
  const url = new URL(`${API}${path}`);
  Object.entries(params ?? {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const started = Date.now();
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' } });
  const body = resp.ok ? await resp.json() : null;
  return { status: resp.status, etag: resp.headers.get('etag'), body, ms: Date.now() - started };
};

async function patchContent(session, ops) {
  const url = `${API}/pages/${session.pageId}/content`;
  const resp = await fetch(url, {
    method: 'PATCH',
    body: JSON.stringify(ops),
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json-patch+json', Accept: 'application/json', 'If-Match': session.etag },
  });
  if (resp.status === 202) return pollJob(url, resp);
  return { status: resp.status, etag: resp.headers.get('etag'), location: resp.headers.get('location'), body: resp.status === 200 ? await resp.json() : await resp.text() };
}

// 202 can happen on any request, whatever its size. The job result carries only id + etag,
// so the content is fetched again to give the caller the same shape as a 200.
async function pollJob(url, accepted) {
  const headers = { Authorization: `Bearer ${token()}`, Accept: 'application/json' };
  const location = new URL(accepted.headers.get('location'), url).href;
  let wait = Number(accepted.headers.get('retry-after')) || 1;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => { setTimeout(r, wait * 1000); });
    const poll = await fetch(location, { headers });
    const job = await poll.json();
    console.log(`patch job ${job.state}`);
    if (job.state === 'COMPLETED') {
      const fresh = await fetch(url, { headers });
      return { status: 200, etag: fresh.headers.get('etag'), body: await fresh.json() };
    }
    if (!['QUEUED', 'PROCESSING'].includes(job.state)) {
      return { status: 502, body: JSON.stringify({ state: job.state, errors: job.errors }) };
    }
    wait = Number(poll.headers.get('retry-after')) || wait;
  }
  return { status: 504, body: 'AEM did not finish the save in time' };
}

const toPublish = (p) => (p === '/index' ? '/' : p);
const fromPage = (page) => (page.publishPath === '/' ? '/index' : page.publishPath);
const pageCache = new Map();
async function pageByPath(publishPath) {
  if (pageCache.has(publishPath)) return pageCache.get(publishPath);
  let page;
  if (publishPath === '/') {
    // publishPath is not unique: '/' matches the site root page rather than the delivered home page.
    const root = await pageByPath(ROOT_PATH);
    page = (await children(root.id)).find((p) => p.publishPath === '/') ?? null;
  } else {
    const { body } = await aem('/pages', { siteId: SITE_ID, publishPath, limit: 1 });
    page = body?.items?.[0] ?? null;
  }
  if (page) pageCache.set(publishPath, page);
  return page;
}
async function children(id) {
  const items = []; let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const { body } = await aem('/pages', { siteId: SITE_ID, parentPageId: id, limit: 50, ...(cursor ? { cursor } : {}) });
    items.push(...(body?.items ?? [])); cursor = body?.cursor;
  } while (cursor);
  return items;
}

// Delivered image paths need the author session, so route them through this server.
const rewriteAssets = (html) => html.replace(/(src|href)="(\/content\/dam\/[^"]+)"/g, (m, a, p) => (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p) ? `${a}="${SELF}/aemcs-asset${p}"` : m));

async function list(path) {
  const rel = path || '/';
  const parent = await pageByPath(rel === '/' ? ROOT_PATH : rel);
  if (!parent) return null;
  const kids = await children(parent.id);
  const out = [];
  await Promise.all(kids.map(async (k) => {
    if (!k.publishPath) return;
    const dp = fromPage(k);
    const lastModified = k.modified?.at ? Date.parse(k.modified.at) : undefined;
    out.push({ name: dp.split('/').pop(), path: `/${ORG}/${REPO}${dp}.html`, ext: 'html', lastModified });
    const { body } = await aem('/pages', { siteId: SITE_ID, parentPageId: k.id, limit: 1 });
    if (body?.items?.length) out.push({ name: dp.split('/').pop(), path: `/${ORG}/${REPO}${dp}` });
  }));
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.ext ? 1 : -1));
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, SELF);
  const headers = {
    ...(ALLOWED_ORIGINS.has(req.headers.origin) ? { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' } : {}),
    // Lets an https page reach this adapter on the loopback address.
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Headers': 'authorization,content-type,da-continuation-token,if-match',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST,PUT',
    'Access-Control-Expose-Headers': 'x-da-actions,x-da-child-actions,x-da-id,etag,x-error',
  };
  const done = (status, body = '', extra = {}, note = '') => {
    appendFileSync(LOG, `${req.method} ${pathname} ${status} ${note}\n`);
    res.writeHead(status, { ...headers, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method === 'OPTIONS') return done(204);
  // CORS only hides responses. A multipart POST is sent without a preflight, so saves check the origin here.
  if (!['GET', 'HEAD'].includes(req.method) && !ALLOWED_ORIGINS.has(req.headers.origin)) return done(403, '', {}, 'BLOCKED-ORIGIN');
  if (['POST', 'PUT'].includes(req.method) && pathname.startsWith('/source/')) {
    try {
      const session = sessions.get(pathname);
      if (!session) return done(409, 'open the document first', { 'x-error': 'open the document first' }, 'NO-SESSION');
      const chunks = []; for await (const c of req) chunks.push(c);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const html = await form.get('data').text();
      const { ops, unsupported } = buildPatch(session, html);
      const live = WRITE_PAGES.has(session.pageId) && !DRY_RUN;
      const entry = { path: pathname, ifMatch: session.etag, live, ops, unsupported };
      const ok = (note) => done(200, JSON.stringify({ source: { contentUrl: `${SELF}${pathname}` } }), { 'Content-Type': 'application/json', 'x-da-actions': `${pathname}=${actionsFor(session.pageId)}` }, note);
      if (unsupported.length) {
        appendFileSync(PATCH_LOG, `${JSON.stringify({ ...entry, result: 'REFUSED' })}\n`);
        return done(422, '', { 'x-error': `Not saved to AEM: ${unsupported[0].reason}` }, `REFUSED ${unsupported.length}`);
      }
      if (!ops.length) { appendFileSync(PATCH_LOG, `${JSON.stringify({ ...entry, result: 'NOOP' })}\n`); return ok('NOOP'); }
      if (!live) { appendFileSync(PATCH_LOG, `${JSON.stringify({ ...entry, result: 'DRY-RUN' })}\n`); return ok('DRY-RUN'); }
      const r = await patchContent(session, ops);
      appendFileSync(PATCH_LOG, `${JSON.stringify({ ...entry, result: r.status })}\n`);
      if (r.status === 200) {
        Object.assign(session, { content: r.body, etag: r.etag, baseHtml: mainOf(html), baseUnits: units(mainOf(html)), baseSig: signature(mainOf(html)), own: ownerMap(r.body) });
        return ok(`PATCHED ops=${ops.length}`);
      }
      const msg = r.status === 412 ? 'This page changed in AEM since you opened it. Reload to continue.' : `AEM returned ${r.status}`;
      return done(r.status === 412 ? 412 : 502, '', { 'x-error': msg }, `PATCH-FAILED ${r.status}`);
    } catch (e) {
      return done(500, String(e.message), { 'x-error': e.message }, `SAVE-ERROR ${e.message}`);
    }
  }
  if (!['GET', 'HEAD'].includes(req.method)) return done(405, 'read-only', {}, 'BLOCKED-WRITE');
  try {
    const m = pathname.match(/^\/(source|list|versionlist|config)\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (pathname.startsWith('/aemcs-asset/')) {
      const r = await fetch(`${HOST}${pathname.replace('/aemcs-asset', '')}`, { headers: { Authorization: `Bearer ${token()}` } });
      return done(r.status, Buffer.from(await r.arrayBuffer()), { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream' }, 'asset');
    }
    if (!m || m[2] !== ORG || m[3] !== REPO) return done(404, '', {}, 'UNHANDLED');
    const [, kind, , , rest = ''] = m;
    if (kind === 'list') {
      const items = await list(rest.replace(/\/$/, ''));
      if (!items) return done(404, '[]', {}, 'no-page');
      return done(200, JSON.stringify(items), { 'Content-Type': 'application/json', 'x-da-child-actions': `${pathname}=read` }, `items=${items.length}`);
    }
    if (kind === 'source') {
      if (!rest.endsWith('.html')) return done(404, '', {}, 'UNHANDLED non-html');
      const page = await pageByPath(toPublish(rest.slice(0, -5)));
      if (!page) return done(404, '', {}, 'no-page');
      const c = await aem(`/pages/${page.id}/content`);
      if (!c.body) return done(c.status, '', {}, 'content-failed');
      const inner = rewriteAssets(tree2html(c.body));
      const base = mainOf(roundTrip(inner));
      const html = `<body><header></header><main>${inner}</main><footer></footer></body>`;
      sessions.set(pathname, { pageId: page.id, content: c.body, etag: c.etag, render: (x) => mainOf(roundTrip(rewriteAssets(tree2html(x)))), baseHtml: base, baseUnits: units(base), baseSig: signature(base), own: ownerMap(c.body), assetPrefix: `${SELF}/aemcs-asset` });
      return done(200, html, { 'Content-Type': 'text/html', 'x-da-actions': `${pathname}=${actionsFor(page.id)}`, 'x-da-id': page.id, ETag: c.etag ?? '' }, `aem=${c.ms}ms`);
    }
    if (kind === 'versionlist') return done(200, '[]', { 'Content-Type': 'application/json' }, 'stub');
    return done(404, '', {}, 'UNHANDLED');
  } catch (e) {
    return done(502, String(e.message), {}, 'ERROR');
  }
});
server.listen(8787, '127.0.0.1', () => console.log('aemcs shim on 127.0.0.1:8787'));
