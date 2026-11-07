// POC: turn a saved DA document into JSON Patch ops against the AEM content tree.
// Compares against a round-tripped baseline so parser normalisation cancels out.
import * as Y from 'yjs';
import { aem2doc, doc2aem } from '@adobe/da-parser';
import { findRoot, renderedSections, fieldsOf, shortType, KEY_VALUE } from './tree2html.mjs';

// model id -> { field: component }, loaded from the site's component-models.json.
export const MODELS = new Map();
const VOID = new Set(['img', 'br', 'hr', 'source', 'meta', 'input']);
export const roundTrip = (body) => { const y = new Y.Doc(); aem2doc(`<body><header></header><main>${body}</main><footer></footer></body>`, y); return doc2aem(y); };
export const mainOf = (s) => { const a = s.indexOf('<main>'); const b = s.lastIndexOf('</main>'); return a >= 0 ? s.slice(a + 6, b) : s; };

// Addressable units: block cells (s0b1r2c0) and default-content elements (s0d3).
export function units(html) {
  const out = []; const re = /<(\/?)([a-z0-9-]+)([^>]*?)(\/?)>/gi; const st = [];
  let m; let sec = -1; let blk = -1; let row = -1; let cell = -1; let start = 0; let def = 0; let defStart = -1;
  while ((m = re.exec(html))) {
    const close = m[1]; const t = m[2].toLowerCase();
    if (!VOID.has(t)) {
      if (!close) {
        st.push(t); const d = st.length;
        if (t === 'div' && d === 1) { sec += 1; blk = -1; def = 0; }
        else if (t === 'div' && d === 2) { blk += 1; row = -1; }
        else if (t === 'div' && d === 3 && st[1] === 'div') { row += 1; cell = -1; }
        else if (t === 'div' && d === 4) { cell += 1; start = re.lastIndex; }
        else if (d === 2) defStart = m.index;
      } else {
        const d = st.length; const top = st.pop();
        if (top === 'div' && d === 4) out.push({ k: `s${sec}b${blk}r${row}c${cell}`, v: html.slice(start, m.index) });
        else if (d === 2 && top !== 'div') { out.push({ k: `s${sec}d${def}`, v: html.slice(defStart, re.lastIndex) }); def += 1; }
      }
    }
  }
  return out;
}

// Block order and shape. Positional diffing is only safe while this is unchanged:
// a moved block otherwise reads as field edits on its neighbours.
export function signature(html) {
  const sig = []; const re = /<(\/?)([a-z0-9-]+)([^>]*?)(\/?)>/gi; const st = []; let m;
  while ((m = re.exec(html))) {
    const t = m[2].toLowerCase();
    if (!VOID.has(t)) {
      if (m[1]) st.pop();
      else {
        st.push(t);
        if (t === 'div' && st.length === 1) sig.push('|');
        else if (t === 'div' && st.length === 2) sig.push(`[${/class="([^"]*)"/.exec(m[3])?.[1] ?? ''}]`);
        else if (t === 'div' && st.length === 3) sig.push('r');
        else if (t === 'div' && st.length === 4) sig.push('c');
      }
    }
  }
  return sig.join('');
}

const fragmentTokens = (h) => units(`<div>${mainOf(roundTrip(`<div>${h}</div>`)).replace(/^<div>/, '').replace(/<\/div>$/, '')}</div>`).filter((u) => /d\d+$/.test(u.k)).length || 1;

export function ownerMap(content) {
  const root = findRoot(content); const map = new Map();
  renderedSections(root).forEach((sec, si) => {
    let b = 0; let dflt = 0;
    (sec.items ?? []).forEach((n) => {
      const t = shortType(n); const p = n.properties ?? {};
      if (t.startsWith('text/') || t.startsWith('title/')) {
        const isText = t.startsWith('text/');
        const c = isText ? fragmentTokens(p.text ?? '') : 1; const keys = [];
        for (let i = 0; i < c; i += 1) keys.push(`s${si}d${dflt + i}`);
        keys.forEach((k) => map.set(k, { n, f: isText ? 'text' : 'title', keys }));
        dflt += c;
      } else if (t.startsWith('block/')) {
        const fs = fieldsOf(n);
        if (KEY_VALUE.has(p.model)) fs.filter((f) => p[f] !== undefined && p[f] !== '').forEach((f, r) => map.set(`s${si}b${b}r${r}c1`, { n, f }));
        else {
          fs.forEach((f, r) => map.set(`s${si}b${b}r${r}c0`, { n, f }));
          (n.items ?? []).forEach((it, r) => fieldsOf(it).forEach((f, c) => map.set(`s${si}b${b}r${fs.length + r}c${c}`, { n: it, f })));
        }
        b += 1;
      } else if (t.startsWith('columns/')) {
        (n.items ?? []).forEach((r, ri) => (r.items ?? []).forEach((c, ci) => (c.items ?? []).forEach((x) => {
          if (shortType(x).startsWith('text/')) map.set(`s${si}b${b}r${ri}c${ci}`, { n: x, f: 'text', whole: true });
        })));
        b += 1;
      } else if (n.componentType) b += 1;
    });
  });
  return map;
}

function pointers(content) {
  const ptr = new Map();
  const walk = (n, p) => { ptr.set(n, p); (n.items ?? []).forEach((c, i) => walk(c, `${p}/items/${i}`)); };
  walk(content, '');
  return ptr;
}

const plain = (v) => v.replace(/^\s*<p>([\s\S]*)<\/p>\s*$/, '$1').trim();
const hasMarkup = (v) => /<(strong|em|u|s|sub|sup|code|br)\b/.test(v);
function kindOf(n, f) {
  const p = n.properties ?? {};
  const typed = (p.modelFields ?? []).find((x) => x.split('@')[0] === f)?.split('@')[1];
  // Item nodes list modelFields without types, so fall back to the model, then the stored value.
  return typed ?? MODELS.get(p.model)?.[f] ?? (/^\s*<[a-z]/i.test(p[f] ?? '') ? 'richtext' : 'text');
}

function fieldOps(n, f, value, assetPrefix) {
  const p = n.properties ?? {}; const issues = []; const vals = {};
  const a = value.match(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
  const img = value.match(/<img [^>]*src="([^"]*)"/);
  if (img) {
    vals[f] = img[1].replace(assetPrefix, '');
    const alt = value.match(/<img [^>]*alt="([^"]*)"/)?.[1];
    if (alt !== undefined && (p.modelFields ?? []).some((x) => x.split('@')[0] === `${f}Alt`)) vals[`${f}Alt`] = alt;
  }
  else if (a && p[`${f}Text`] !== undefined) { vals[f] = a[1]; vals[`${f}Text`] = a[2]; }
  else if (a && !/\S/.test(plain(value).replace(/<a [\s\S]*<\/a>/, ''))) vals[f] = a[1];
  else if (kindOf(n, f) === 'richtext') vals[f] = value.trim();
  else {
    const h = plain(value).match(/^<(h[1-6])[^>]*>([\s\S]*)<\/\1>$/);
    const text = h ? h[2] : plain(value);
    if (h && p[`${f}Type`] && p[`${f}Type`] !== h[1]) vals[`${f}Type`] = h[1];
    if (hasMarkup(text)) issues.push(`formatting in plain ${f} field would be lost or stored as markup`);
    vals[f] = text;
  }
  return { vals, issues };
}

const defaultKeys = (map, sec) => [...map.keys()].filter((k) => k.startsWith(`s${sec}d`)).sort((x, y) => Number(x.split('d')[1]) - Number(y.split('d')[1]));

// Aligns one section's default content by common prefix and suffix, so a new or
// removed paragraph does not read as an edit to everything after it.
function defaultEdits(sec, a, b, own, add, unsupported) {
  const bk = defaultKeys(a, sec); const B = bk.map((k) => a.get(k)); const A = defaultKeys(b, sec).map((k) => b.get(k));
  let p = 0; while (p < B.length && p < A.length && B[p] === A[p]) p += 1;
  let e = 0; while (e < B.length - p && e < A.length - p && B[B.length - 1 - e] === A[A.length - 1 - e]) e += 1;
  if (p === B.length && p === A.length) return;
  const write = (o, tokens) => {
    if (o.f === 'title') {
      const h = tokens.length === 1 && tokens[0].match(/^<(h[1-6])[^>]*>([\s\S]*)<\/\1>$/);
      if (!h) { unsupported.push({ key: `s${sec}`, reason: 'a title component can only hold one heading' }); return; }
      add(o.n, 'title', h[2]);
      if (o.n.properties.titleType && o.n.properties.titleType !== h[1]) add(o.n, 'titleType', h[1]);
      return;
    }
    add(o.n, 'text', tokens.join(''));
  };
  const span = bk.slice(p, B.length - e); const owners = new Set(span.map((k) => own.get(k)?.n));
  if (span.length && owners.size > 1 && A.length === B.length) {
    const done = new Set();
    span.forEach((k) => {
      const o = own.get(k); if (done.has(o.n)) return; done.add(o.n);
      write(o, o.keys.map((x) => A[bk.indexOf(x)]));
    });
    return;
  }
  if (owners.size > 1) { unsupported.push({ key: `s${sec}`, reason: 'an edit spans more than one text component' }); return; }
  const before = own.get(bk[p - 1]); const next = own.get(bk[B.length - e]);
  const o = span.length ? own.get(span[0]) : [before, next].find((x) => x?.f === 'text');
  if (!o) { unsupported.push({ key: `s${sec}`, reason: 'new text has no text component to go in' }); return; }
  const i0 = bk.indexOf(o.keys[0]); const i1 = bk.indexOf(o.keys.at(-1));
  write(o, [...B.slice(i0, Math.min(p, i1 + 1)), ...A.slice(p, A.length - e), ...B.slice(Math.max(B.length - e, i0), i1 + 1)]);
}

function applyOps(doc, ops) {
  const at = (p) => p.split('/').slice(1).reduce((n, k) => n[k], doc);
  const cut = (p) => { const i = p.lastIndexOf('/'); return [at(p.slice(0, i)), Number(p.slice(i + 1))]; };
  ops.forEach((o) => {
    if (o.op === 'remove') { const [a, i] = cut(o.path); a.splice(i, 1); }
    if (o.op === 'move') { const [a, i] = cut(o.from); const [v] = a.splice(i, 1); const [b, j] = cut(o.path); b.splice(j, 0, v); }
  });
  return doc;
}

// Splits a page into sections of whole blocks plus everything else in the section.
function layout(html) {
  const secs = []; const re = /<(\/?)([a-z0-9-]+)([^>]*?)(\/?)>/gi; const st = [];
  let m; let sec; let cursor = 0; let start = -1;
  while ((m = re.exec(html))) {
    const t = m[2].toLowerCase();
    if (!VOID.has(t) && !m[4]) {
      if (m[1]) {
        const depth = st.length; st.pop();
        if (depth === 2 && start >= 0) {
          const block = html.slice(start, re.lastIndex);
          if (!block.startsWith('<div class="section-metadata')) {
            sec.rest += html.slice(cursor, start); sec.blocks.push(block); cursor = re.lastIndex;
          }
          start = -1;
        } else if (depth === 1) sec.rest += html.slice(cursor, m.index);
      } else {
        st.push(t);
        if (st.length === 1) { sec = { rest: '', blocks: [] }; secs.push(sec); cursor = re.lastIndex; }
        if (st.length === 2 && t === 'div') start = m.index;
      }
    }
  }
  return secs;
}

// AEM has no stable page-wide node id, so blocks are matched by their rendered content and
// addressed by position. If-Match on the save is what makes those positions safe to use.
function structuralOps(content, baseHtml, savedHtml, render) {
  const refuse = (reason) => ({ ops: [], unsupported: [{ key: '*', reason }] });
  const A = layout(baseHtml); const B = layout(savedHtml);
  if (A.length !== B.length) return refuse('sections were added or removed, which is not supported yet');
  if (A.some((x, i) => x.rest !== B[i].rest)) return refuse('text was changed in the same save as a block move or delete');
  const ptr = pointers(content);
  const isBlock = (n) => { const t = shortType(n); return n.componentType && !t.startsWith('text/') && !t.startsWith('title/'); };
  const cur = renderedSections(findRoot(content)).map((x) => ({ ptr: ptr.get(x), items: x.items.map((n) => ({ n })) }));
  if (cur.length !== A.length) return refuse('this page has a section the adapter cannot address');
  for (let i = 0; i < cur.length; i += 1) {
    const slots = cur[i].items.filter((x) => isBlock(x.n));
    if (slots.length !== A[i].blocks.length) return refuse('this page has a block the adapter cannot address');
    slots.forEach((x, j) => { x.fp = A[i].blocks[j]; });
  }
  const pool = A.flatMap((x) => x.blocks);
  for (const fp of B.flatMap((x) => x.blocks)) {
    const at = pool.indexOf(fp);
    if (at < 0) return refuse('a block was added or changed, which is not supported yet');
    pool.splice(at, 1);
  }
  const ops = [];
  const keep = B.flatMap((x) => x.blocks);
  cur.forEach((c) => {
    const kept = c.items.map((x) => { if (!x.fp) return true; const i = keep.indexOf(x.fp); if (i < 0) return false; keep.splice(i, 1); return true; });
    for (let i = c.items.length - 1; i >= 0; i -= 1) {
      if (!kept[i]) { ops.push({ op: 'remove', path: `${c.ptr}/items/${i}` }); c.items.splice(i, 1); }
    }
  });
  B.forEach((sec, si) => sec.blocks.forEach((fp) => {
    const open = () => cur[si].items.find((x) => x.fp && !x.placed);
    const next = open();
    if (next?.fp === fp) { next.placed = true; return; }
    const src = [cur[si], ...cur].find((c) => c.items.some((x) => x.fp === fp && !x.placed));
    const fi = src.items.findIndex((x) => x.fp === fp && !x.placed);
    const [item] = src.items.splice(fi, 1);
    const anchor = open(); const ti = anchor ? cur[si].items.indexOf(anchor) : cur[si].items.length;
    cur[si].items.splice(ti, 0, item); item.placed = true;
    ops.push({ op: 'move', from: `${src.ptr}/items/${fi}`, path: `${cur[si].ptr}/items/${ti}` });
  }));
  // An empty section stops rendering, which would shift every later section's position.
  if (cur.some((c) => !c.items.length)) return refuse('the last block in a section cannot be moved or deleted yet');
  // Never send a patch unless applying it reproduces exactly what the editor saved.
  if (render(applyOps(structuredClone(content), ops)) !== savedHtml) return refuse('this block move cannot be expressed safely, for example past text in the same section');
  return { ops, unsupported: [] };
}

// Returns { ops, unsupported }. The ops are never sent by this module.
export function buildPatch({ content, baseHtml, baseUnits, baseSig, own, assetPrefix, render }, savedHtml) {
  if (signature(mainOf(savedHtml)) !== baseSig) return structuralOps(content, baseHtml, mainOf(savedHtml), render);
  const after = units(mainOf(savedHtml)); const ptr = pointers(content);
  const a = new Map(baseUnits.map((u) => [u.k, u.v])); const b = new Map(after.map((u) => [u.k, u.v]));
  const ops = []; const unsupported = [];
  const add = (n, f, v) => {
    const exists = n.properties?.[f] !== undefined;
    if (exists ? n.properties[f] === v : v === '') return;
    ops.push({ op: exists ? 'replace' : 'add', path: `${ptr.get(n)}/properties/${f}`, value: v });
  };
  const sections = new Set([...a.keys(), ...b.keys()].map((k) => k.match(/^s(\d+)/)[1]));
  sections.forEach((sec) => defaultEdits(sec, a, b, own, add, unsupported));
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => /b\d+r/.test(k) && a.get(k) !== b.get(k)).forEach((k) => {
    const o = own.get(k);
    if (!a.has(k) || !b.has(k) || !o) { unsupported.push({ key: k, reason: !o ? 'this cell has no matching AEM field' : 'rows or cells were added or removed' }); return; }
    if (o.whole) { add(o.n, o.f, b.get(k)); return; }
    const { vals, issues } = fieldOps(o.n, o.f, b.get(k), assetPrefix);
    const before = ops.length;
    Object.entries(vals).forEach(([f, v]) => add(o.n, f, v));
    issues.forEach((reason) => unsupported.push({ key: k, reason }));
    // The cell changed, so writing nothing would report "Saved" for an edit AEM never got.
    if (ops.length === before && !issues.length) unsupported.push({ key: k, reason: 'this change has no matching AEM field' });
  });
  return { ops, unsupported };
}
