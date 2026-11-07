# AEM Cloud Service adapter (POC)

Proof of concept, not product code, and not intended for merge. It answers one question: what
does it take for Experience Workspace (EW) to edit a page stored in AEM as a Cloud Service,
delivered through Edge Delivery (Crosswalk), using the Page Management API?

The useful output is what it taught us about the AEM model and the API. Treat the code as prior
art to read, not a base to build on.

## How it works

```text
EW (browser)  --DA admin API-->  adapter (localhost:8787)  --Page Management API-->  AEM author
              <--document HTML--                           <--JSON component tree--
```

EW doesn't know AEM is involved. The adapter answers the DA admin calls EW makes (`/source`,
`/list`, `/config`) and translates in both directions:

- **Open:** read the page's JSON tree and render it to the section and block HTML EW expects.
- **Save:** diff the HTML EW saved against what was served, and send only the difference as JSON
  Patch, with `If-Match` carrying the page ETag.

EW itself changes in only two files, behind `?aemcs`: `blocks/shared/constants.js` turns on the
WebSocket-free save path from #1478 (merged into this branch), and
`blocks/canvas/editor-utils/editor-utils.js` points the preview at the site's `aem.page` origin.

## Reading order

| File | What it does |
| --- | --- |
| `tree2html.mjs` | AEM tree to HTML. Short; read first, since everything else depends on it. |
| `patch.mjs` | HTML to JSON Patch. The core of the POC; start at `buildPatch` at the bottom. |
| `server.mjs` | The DA admin impersonation: routing, sessions, AEM calls, block library. |
| `patch-test.mjs` | Offline regression over captured pages. Shows the scenarios covered. |
| `live-save.mjs` | Sends scripted saves through the adapter to real AEM, without a browser. |

## What the AEM model forces

These shaped the design, and any real implementation will meet them too:

- **No stable block id.** A node's `id` is its JCR name, unique only among siblings, and
  `capi-key` is positional. Nodes are matched by rendered content and addressed by position, and
  `If-Match` is what makes positions safe.
- **Saves need structure, not text.** EW saves a whole document; AEM takes field-level ops. An
  edit that can't map to a field must fail visibly, so the adapter refuses instead of guessing.
- **Check before sending.** Structural patches are applied to a copy and rendered. They are only
  sent if the result matches what the editor saved. This caught several wrong patches in testing.
- **Blocks come from a library.** EW only offers blocks from a site library, so the adapter
  generates one from `component-definition.json` and `component-filters.json`. A new block is
  recognised by its exact template, so `add` only needs `componentType` and `properties`.
- **`modelFields` can't be trusted alone.** It is a snapshot that can drift from the current
  model, and nodes created through the API don't have it. `component-models.json` fills the gap.
- **202 can answer any request.** Handling follows the spec, but we never saw one in testing.

## What is refused

Each of these shows an error with Retry in EW, and nothing is written:

- Adding or removing sections, or moving or deleting a section's last block
- Editing a block in the same save as moving or adding it
- Adding rows or cells, or adding container blocks such as `cards`
- Changing a cell with no matching AEM field, or formatting in a plain text field
- Any structural patch that doesn't reproduce the saved page

Saving rich text also rewrites the whole field through ProseMirror, which normalises markup: it
unwraps `<li><p>`, and drops empty `<p>` and `<a>` without `href`. Nothing here handles publishing,
page metadata, comments, `.da` configuration or forms.

## Running it

You need an AEM Cloud Service author instance with the Page Management API, a Crosswalk site, and
an IMS token for that instance saved in a file. Use a page you can throw away for writes.

```sh
npm install

AEMCS_HOST=https://author-pXXXX-eXXXX.adobeaemcloud.com \
AEMCS_SITE=<site id> \
AEMCS_ORG=<EDS org> \
AEMCS_REPO=<EDS site> \
AEMCS_TOKEN_FILE=<file holding the token> \
AEMCS_WRITE_PAGE=<page id allowed to take writes> \
node tools/aemcs-shim/server.mjs
```

Serve da-live on `localhost:3000`, then open:

```text
http://localhost:3000/canvas?aemcs&da-admin=local&nx=local#/<org>/<site>/<page>
```

`nx=local` assumes a local da-nx. Localhost signs in through IMS stage, while a production AEM
instance is on IMS prod. The adapter's token file is what lets the two work together, and the two
sign-ins need separate Chrome profiles because they set the same cookies.

| Variable | Purpose |
| --- | --- |
| `AEMCS_HOST` | Author instance URL. Required. |
| `AEMCS_SITE` | Site id in the Page Management API. Required. |
| `AEMCS_TOKEN_FILE` | File holding the IMS token. Read on each call, so it can be replaced live. |
| `AEMCS_WRITE_PAGE` | Comma-separated page ids that accept writes. Without it, all are read-only. |
| `AEMCS_DRY_RUN` | Set to `1` to log patches and send nothing. |
| `AEMCS_ORG`, `AEMCS_REPO` | EDS org and site. Default to the demo site. |
| `AEMCS_ROOT` | AEM page shown as the site root. Defaults to `/en`. |
| `AEMCS_ORIGINS` | Extra comma-separated origins allowed to call the adapter. |
| `AEMCS_LOG`, `AEMCS_PATCH_LOG` | Files for the request log and for every patch or refusal. |

The token stays in the adapter and never reaches the browser. Never commit it. Restart the adapter
after creating a page, because page lookups are cached.

## Offline tests

`patch-test.mjs` runs edits, moves, deletes and adds against saved pages, with no AEM connection.
The inputs aren't committed, so capture your own:

- `AEMCS_FIXTURES`: JSON of `{ "pages": [{ "page": { "name": "..." }, "content": <tree> }] }`, with
  each tree from `GET /pages/{id}/content`
- `AEMCS_DEFS`: the site's `component-definition.json`
- `AEMCS_MODELS`: the site's `component-models.json`

```sh
AEMCS_FIXTURES=<file> AEMCS_DEFS=<file> AEMCS_MODELS=<file> node tools/aemcs-shim/patch-test.mjs
```

Against 9 Frescopa pages, 399 of 402 checks pass. The rest are one blank-paragraph delete that does
nothing, and two blocks whose stored fields differ from the current model. Rows ending in `max ops`
report the largest patch seen rather than a count of checks.
