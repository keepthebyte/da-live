// Sends the adapter the same multipart save the editor posts, without the editor.
// Usage: node live-save.mjs <path.html> <cases.mjs>; each case is { name, edit(html) => html }.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { roundTrip, mainOf } from './patch.mjs';

const [, , path, casesFile] = process.argv;
const url = `http://127.0.0.1:8787/source/aem-showcase/frescopa/${path}`;
const headers = { Origin: 'http://localhost:3000' };
const { default: cases } = await import(pathToFileURL(resolve(casesFile)).href);
for (const c of cases) {
  const base = roundTrip(mainOf(await (await fetch(url, { headers })).text()));
  const next = c.edit(base);
  if (next === base) { console.log(`${c.name}: SKIPPED, edit matched nothing`); continue; }
  const body = new FormData();
  body.append('data', new Blob([next], { type: 'text/html' }));
  const r = await fetch(url, { method: 'POST', headers, body });
  console.log(`${c.name}: HTTP ${r.status} ${r.headers.get('x-error') ?? ''}`);
}
