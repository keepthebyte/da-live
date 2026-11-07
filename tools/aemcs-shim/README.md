# AEMaaCS adapter (POC)

Throwaway proof of concept, not product code. A local server that impersonates the DA admin API
and converts AEM page content to and from DA HTML, so Experience Workspace can edit an AEM as a
Cloud Service page through the Page Management API.

```sh
AEMCS_HOST=https://author-pXXXX-eXXXX.adobeaemcloud.com \
AEMCS_SITE=<site id> \
AEMCS_TOKEN_FILE=<file holding an IMS token for that instance> \
AEMCS_WRITE_PAGE=<page id allowed to take writes> \
node tools/aemcs-shim/server.mjs
```

Then open a page with `?aemcs&da-admin=local`. Without `AEMCS_WRITE_PAGE` the adapter is read-only.
The token stays in the adapter and is never sent to the browser.
