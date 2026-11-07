// Spike: AEM Page Management content tree -> EDS/DA section+block HTML.
const COLLAPSE = ['Alt', 'Type', 'Text', 'Title', 'MimeType'];
const fieldName = (f) => f.split('@')[0];
const fieldKind = (f) => f.split('@')[1];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const kebab = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const shortType = (n) => (n.componentType ?? '').replace('core/franklin/components/', '');
const isImagePath = (v) => /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(v) || /urn:aaid/.test(v);

function fieldsOf(node) {
  const p = node.properties ?? {};
  const list = (p.modelFields ?? []).map(fieldName);
  const set = new Set(list);
  return list.filter((f) => {
    if (f === 'classes' || f.startsWith('classes_') || f === 'name' || f === 'model') return false;
    return !COLLAPSE.some((s) => f.endsWith(s) && set.has(f.slice(0, -s.length)));
  });
}

function cell(p, f) {
  const v = p[f];
  if (v === undefined || v === null || v === '') return '';
  if (Array.isArray(v)) return esc(v.join(', '));
  const s = String(v);
  if (p[`${f}Type`] && /^h[1-6]$/.test(p[`${f}Type`])) return `<${p[`${f}Type`]}>${esc(s)}</${p[`${f}Type`]}>`;
  if (/^\s*</.test(s)) return s;
  if (s.startsWith('/') || /^https?:/.test(s)) {
    if (isImagePath(s)) return `<img src="${s}" alt="${esc(p[`${f}Alt`])}">`;
    return `<a href="${s}">${esc(p[`${f}Text`] ?? s)}</a>`;
  }
  return esc(s);
}

export const KEY_VALUE = new Set();
function block(node) {
  const p = node.properties ?? {};
  if (KEY_VALUE.has(p.model)) {
    const rows = fieldsOf(node).filter((f) => p[f] !== undefined && p[f] !== '').map((f) => `<div><div>${f}</div><div>${cell(p, f)}</div></div>`);
    return `<div class="${kebab(p.name ?? p.model)}">${rows.join('')}</div>`;
  }
  const classes = [kebab(p.name ?? p.model ?? shortType(node)), ...(Array.isArray(p.classes) ? p.classes : [p.classes].filter(Boolean))];
  const rows = fieldsOf(node).map((f) => `<div><div>${cell(p, f)}</div></div>`);
  (node.items ?? []).forEach((item) => {
    const ip = item.properties ?? {};
    const cells = fieldsOf(item).map((f) => `<div>${cell(ip, f)}</div>`);
    rows.push(`<div>${cells.join('')}</div>`);
  });
  return `<div class="${classes.join(' ')}">${rows.join('')}</div>`;
}

export const unknown = {};
function component(node) {
  const t = shortType(node);
  const p = node.properties ?? {};
  if (t.startsWith('text/')) return p.text ?? '';
  if (t.startsWith('title/')) return `<${p.titleType ?? 'h2'}>${esc(p.title ?? p['jcr:title'])}</${p.titleType ?? 'h2'}>`;
  if (t.startsWith('image/')) return `<p><img src="${p.fileReference ?? p.image ?? ''}" alt="${esc(p.alt)}"></p>`;
  if (t.startsWith('button/')) return `<p><a href="${p.link ?? ''}">${esc(p.linkText ?? p.text)}</a></p>`;
  if (t.startsWith('block/')) return block(node);
  if (t.startsWith('columns/')) {
    const rows = (node.items ?? []).map((r) => `<div>${(r.items ?? []).map((c) => `<div>${(c.items ?? []).map(component).join('')}</div>`).join('')}</div>`);
    return `<div class="columns">${rows.join('')}</div>`;
  }
  if (!node.componentType) return ''; // orphan node: not delivered, must survive saves
  unknown[node.componentType ?? 'null'] = (unknown[node.componentType ?? 'null'] ?? 0) + 1;
  return `<div class="${kebab(p.name ?? p.model ?? 'unknown')}" data-opaque="${node.id}"></div>`;
}

function section(node) {
  const p = node.properties ?? {};
  const style = Array.isArray(p.style) ? p.style.join(', ') : p.style;
  const meta = p.modelFields ? `<div class="section-metadata"><div><div>${style ? 'style' : ''}</div>${style ? `<div>${esc(style)}</div>` : ''}</div></div>` : '';
  return `<div>${(node.items ?? []).map(component).join('')}${meta}</div>`;
}

export function findRoot(n) {
  if (shortType(n).startsWith('root/')) return n;
  for (const c of n.items ?? []) { const r = findRoot(c); if (r) return r; }
  return null;
}

export const renderedSections = (root) => (root.items ?? []).filter((n) => shortType(n).startsWith('section/') && (n.items ?? []).length);
export { fieldsOf, shortType };
export function tree2html(content) {
  const root = findRoot(content) ?? content;
  return renderedSections(root).map(section).join('');
}
