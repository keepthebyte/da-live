// Offline regression: AEMCS_FIXTURES=<json> AEMCS_DEFS=<defs.json> AEMCS_MODELS=<models.json> node patch-test.mjs
import { readFileSync } from 'node:fs';
import { tree2html, KEY_VALUE, findRoot, shortType, fieldsOf, renderedSections } from './tree2html.mjs';
import { roundTrip, mainOf, units, signature, ownerMap, buildPatch, registerBlock, MODELS } from './patch.mjs';

const read = (e) => JSON.parse(readFileSync(process.env[e], 'utf8'));
read('AEMCS_DEFS').groups.forEach((g) => g.components.forEach((c) => { const t = c.plugins?.xwalk?.page?.template; if (t?.['key-value']) KEY_VALUE.add(t.model ?? c.id); }));
read('AEMCS_MODELS').forEach((m) => MODELS.set(m.id, Object.fromEntries((m.fields ?? []).filter((f) => f.component !== 'tab').map((f) => [f.name, f.component]))));
const TEMPLATES = read('AEMCS_DEFS').groups.flatMap((g) => g.components).map((x) => x.plugins?.xwalk?.page).filter((x) => x?.template?.model && x.resourceType?.includes('/block/')).map((x) => ({ componentType: x.resourceType, properties: x.template }));
TEMPLATES.forEach(registerBlock);
const session = (content) => { const base = mainOf(roundTrip(tree2html(content))); return { content, render: (x) => mainOf(roundTrip(tree2html(x))), baseHtml: base, baseUnits: units(base), baseSig: signature(base), own: ownerMap(content), assetPrefix: 'http://x' }; };
const tot = {}; const fails = [];
const hit = (name, ok, note) => { tot[name] ??= { pass: 0, fail: 0 }; tot[name][ok ? 'pass' : 'fail'] += 1; if (!ok) fails.push(`${name}: ${note}`); };
const collect = (n, path, acc) => {
  const t = shortType(n); const p = n.properties ?? {};
  if (t.startsWith('text/') && p.text) acc.push({ n, f: 'text', kind: 'text-component', path });
  if (t.startsWith('title/')) acc.push({ n, f: 'title', kind: 'title', path });
  if (/^block\//.test(t) && p.modelFields) fieldsOf(n).forEach((f) => {
    const v = p[f]; if (typeof v !== 'string' || !v) return;
    const kind = /^\s*</.test(v) ? 'richtext-field' : /^(\/|https?:)/.test(v) ? (/\.(png|jpe?g|webp|svg|gif)$/i.test(v) ? 'image' : 'link') : /^h[1-6]$/.test(v) ? null : 'plain-field';
    if (kind) acc.push({ n, f, kind, path });
  });
  (n.items ?? []).forEach((c, i) => collect(c, `${path}/items/${i}`, acc));
  return acc;
};
for (const pg of read('AEMCS_FIXTURES').pages) {
  const c = pg.content; const s = session(c);
  const noop = buildPatch(s, roundTrip(tree2html(c)));
  hit('no-op save', !noop.ops.length && !noop.unsupported.length, `${pg.page.name} ${JSON.stringify(noop).slice(0, 160)}`);
  for (const e of collect(findRoot(c), `/items/${c.items.indexOf(findRoot(c))}`, [])) {
    const old = e.n.properties[e.f]; const mark = 'ZZ';
    let next;
    if (e.kind === 'image') next = old.replace(/(\.[a-z]+)$/i, `-new$1`);
    else if (e.kind === 'link') next = `${old}-new`;
    else if (/<\/(p|h[1-6]|li)>/.test(old)) next = old.replace(/<\/(p|h[1-6]|li)>/, `${mark}</$1>`);
    else next = old + mark;
    e.n.properties[e.f] = next; const html = roundTrip(tree2html(c)); e.n.properties[e.f] = old;
    const r = buildPatch(s, html); const want = `${e.path}/properties/${e.f}`;
    const op = r.ops.find((o) => o.path === want);
    const clean = (v) => String(v).replace(/\s+id="[^"]*"/g, '').replace(/&nbsp;| /g, ' ').replace(/&#x26;|&amp;/g, '&').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
    const sortAttrs = (v) => v.replace(/<([a-z0-9]+)((?:\s+[a-z-]+="[^"]*")+)\s*>/gi, (m, t, at) => `<${t} ${at.trim().match(/[a-z-]+="[^"]*"/gi).sort().join(' ')}>`);
    const unwrap = (v) => v.replace(/<li><p>([\s\S]*?)<\/p><\/li>/g, '<li>$1</li>').replace(/<p>\s*<\/p>/g, '').replace(/<a(?![^>]*href=)[^>]*>([\s\S]*?)<\/a>/g, '$1').replace(/\s+/g, '');
    const g0 = sortAttrs(clean(op?.value ?? '')); const w0 = sortAttrs(clean(next));
    const ok = r.ops.length === 1 && op && !r.unsupported.length && unwrap(g0) === unwrap(w0);
    if (ok && g0 !== w0) hit('  (markup normalised)', true);
    hit(`edit ${e.kind}`, ok, `${pg.page.name} ${e.f} ops=${r.ops.length} unsup=${r.unsupported[0]?.reason ?? ''} ${(() => { const g = unwrap(g0); const w = unwrap(w0); let i = 0; while (i < g.length && g[i] === w[i]) i += 1; return `len ${g.length}/${w.length} at ${i} got=[${g.slice(Math.max(0, i - 30), i + 60)}] want=[${w.slice(Math.max(0, i - 30), i + 60)}]`; })()}`);
  }
  const texts = collect(findRoot(c), '', []).filter((e) => e.kind === 'text-component' && /<\/p>/.test(e.n.properties.text));
  for (const e of texts) {
    const old = e.n.properties.text;
    e.n.properties.text = old.replace('</p>', '</p><p>Inserted</p>');
    const splitHtml = roundTrip(tree2html(c)); e.n.properties.text = old;
    const r = buildPatch(s, splitHtml);
    hit('split paragraph', r.ops.length === 1 && !r.unsupported.length && r.ops[0].value.includes('Inserted') && r.ops[0].path.endsWith('/text'), `${pg.page.name} ops=${r.ops.length} ${r.unsupported[0]?.reason ?? ''} src=[${old.slice(0, 120)}]`);
    const firstP = old.match(/<p>[\s\S]*?<\/p>/)?.[0];
    if (firstP && (old.match(/<(p|h[1-6]|ul|ol)\b/g) ?? []).length > 1) {
      e.n.properties.text = old.replace(firstP, '');
      const delHtml = roundTrip(tree2html(c)); e.n.properties.text = old;
      const d = buildPatch(s, delHtml);
      hit('delete paragraph', d.ops.length === 1 && !d.unsupported.length, `${pg.page.name} ops=${d.ops.length} ${d.unsupported[0]?.reason ?? ''} removed=[${firstP.slice(0, 80)}]`);
    }
  }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const at = (doc, p) => p.split('/').slice(1).reduce((n, k) => n[k], doc);
const apply = (doc, ops) => { ops.forEach((o) => {
  const cut = (p) => { const i = p.lastIndexOf('/'); return [at(doc, p.slice(0, i)), Number(p.slice(i + 1))]; };
  if (o.op === 'remove') { const [arr, i] = cut(o.path); arr.splice(i, 1); }
  if (o.op === 'add' && /\/items\/\d+$/.test(o.path)) { const [a, i] = cut(o.path); a.splice(i, 0, clone(o.value)); return; }
  if (o.op === 'replace' || o.op === 'add') { const i = o.path.lastIndexOf('/'); at(doc, o.path.slice(0, i))[o.path.slice(i + 1)] = o.value; }
  if (o.op === 'move') { const [a, i] = cut(o.from); const [v] = a.splice(i, 1); const [b, j] = cut(o.path); b.splice(j, 0, v); }
}); return doc; };
const isB = (n) => n.componentType && !/^(text|title)\//.test(shortType(n));
const check = (name, pg, c, mutate) => {
  const s = session(c); const next = clone(c); const secs = renderedSections(findRoot(next));
  if (mutate(secs) === false) return;
  const saved = roundTrip(tree2html(next)); const r = buildPatch(s, saved);
  const got = roundTrip(tree2html(apply(clone(c), r.ops)));
  // Refusing is safe; a patch that produces a different page is the failure.
  if (r.unsupported.length && !r.ops.length) { hit(`${name} (refused)`, true); return; }
  hit(name, mainOf(got) === mainOf(saved), `${pg} ops=${r.ops.length} ${JSON.stringify(r.ops).slice(0, 170)} ${(() => { const g = mainOf(got); const w = mainOf(saved); let i = 0; while (i < g.length && g[i] === w[i]) i += 1; return `at ${i}/${w.length} got=[${g.slice(Math.max(0, i - 40), i + 70)}] want=[${w.slice(Math.max(0, i - 40), i + 70)}]`; })()}`);
  tot[`${name} max ops`] = { pass: Math.max(tot[`${name} max ops`]?.pass ?? 0, r.ops.length), fail: 0 };
};
for (const pg of read('AEMCS_FIXTURES').pages) {
  const c = pg.content; const n = renderedSections(findRoot(c)).length;
  for (let i = 0; i < n; i += 1) {
    const idx = (x) => x.items.map((v, k) => (isB(v) ? k : -1)).filter((k) => k >= 0);
    check('block reorder', pg.page.name, c, (S) => { const b = idx(S[i]); if (b.length < 2) return false; const [v] = S[i].items.splice(b[0], 1); S[i].items.splice(b.at(-1), 0, v); return true; });
    const everyPair = (S) => S[i].items.length > 2 && S[i].items.some((v) => isB(v));
    for (let p = 0; p < renderedSections(findRoot(c))[i].items.length; p += 1) {
      for (let q = 0; q < renderedSections(findRoot(c))[i].items.length; q += 1) {
        if (p !== q) check('block reorder any', pg.page.name, c, (S) => { if (!everyPair(S) || !isB(S[i].items[p])) return false; const [v] = S[i].items.splice(p, 1); S[i].items.splice(q, 0, v); return true; });
      }
    }
    check('block delete', pg.page.name, c, (S) => { const b = idx(S[i]); if (!b.length || S[i].items.length < 2) return false; S[i].items.splice(b[0], 1); return true; });
    for (let j = 0; j < n; j += 1) {
      if (i !== j) check('block cross-section', pg.page.name, c, (S) => { const b = idx(S[i]); if (!b.length || S[i].items.length < 2) return false; const [v] = S[i].items.splice(b[0], 1); S[j].items.push(v); return true; });
    }
  }
  const walk = (n) => { const p = n.properties; if (p?.modelFields && p.model && MODELS.has(p.model) && /^block\//.test(shortType(n))) { const a = fieldsOf(n).join(); const b = fieldsOf({ properties: { ...p, modelFields: undefined } }).join(); hit('fields from model', a === b, `${pg.page.name} ${p.model} stored=[${a}] model=[${b}]`); } (n.items ?? []).forEach(walk); };
  walk(findRoot(c));
  TEMPLATES.forEach((t, ti) => { if (ti % 3 === 0) check('add block', pg.page.name, c, (S) => { S[0].items.push(clone(t)); return true; }); });
  const s = session(c); const m = clone(c); const S = renderedSections(findRoot(m)); const lone = S.find((x) => x.items.length === 1 && isB(x.items[0]));
  if (lone) { lone.items.length = 0; lone.items.push(); const h = tree2html(c).replace(/<div class="(?!section-metadata)[^"]*">[\s\S]*?<\/div><\/div><\/div>/, ''); const r = buildPatch(s, roundTrip(h)); hit('refuses without ops', r.ops.length === 0 && r.unsupported.length > 0, `${pg.page.name} ops=${r.ops.length}`); }
  const e = clone(c); const T = collect(findRoot(e), '', []).find((x) => x.kind === 'text-component' || x.kind === 'title');
  const B0 = renderedSections(findRoot(e)).find((x) => x.items.filter(isB).length && x.items.length > 1);
  if (T && B0) { T.n.properties[T.f] = T.f === 'title' ? `${T.n.properties[T.f]}ZZ` : T.n.properties[T.f].replace(/<\/(p|h[1-6])>/, 'ZZ</$1>'); B0.items.splice(B0.items.findIndex(isB), 1); const r = buildPatch(s, roundTrip(tree2html(e))); hit('refuses edit + delete', r.ops.length === 0 && r.unsupported.length > 0, `${pg.page.name} ops=${r.ops.length}`); }
}
Object.entries(tot).forEach(([k, v]) => console.log(k.padEnd(22), `pass ${v.pass}`, v.fail ? `FAIL ${v.fail}` : ''));
console.log(fails.slice(0, 14).join('\n'));
