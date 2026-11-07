export const AEM_ORIGIN = 'https://admin.hlx.page';

// POC: ?aemcs runs EW against the local AEM adapter (tools/aemcs-shim).
// POC: ?aemcs points the editor at the AEM Cloud Service adapter in tools/aemcs-shim, which has
// no collab server, so it uses the WebSocket-free save path from offline mode.
export const AEMCS = new URLSearchParams(window.location.search).has('aemcs');
export const OFFLINE_MODE = AEMCS;

export const SUPPORTED_IMAGE_TYPES = [
  'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/avif', 'image/webp',
];

export const SUPPORTED_FILES = {
  html: 'text/html',
  jpeg: 'image/jpeg',
  json: 'application/json',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

const DA_ADMIN_ENVS = {
  local: 'http://localhost:8787',
  stage: 'https://stage-admin.da.live',
  prod: 'https://admin.da.live',
};

const DA_COLLAB_ENVS = {
  local: 'ws://localhost:4711',
  stage: 'wss://stage-collab.da.live',
  prod: 'wss://collab.da.live',
};

const DA_CONTENT_ENVS = {
  local: 'http://localhost:8788',
  stage: 'https://stage-content.da.live',
  prod: 'https://content.da.live',
};

const DA_LIVE_PREVIEW_ENVS = {
  local: 'localhost:8000',
  stage: 'stage-preview.da.live',
  prod: 'preview.da.live',
};

const DA_ETC_ENVS = {
  prod: 'https://da-etc.adobeaem.workers.dev',
  local: 'http://localhost:8787',
};

function getDaEnv(location, key, envs) {
  const { href } = location;
  const query = new URL(href).searchParams.get(key);
  if (query && query === 'reset') {
    localStorage.removeItem(key);
  } else if (query) {
    localStorage.setItem(key, query);
  }
  const env = envs[localStorage.getItem(key) || 'prod'];
  // TODO: INFRA
  return location.origin === 'https://da.page' ? env.replace('.live', '.page') : env;
}

export const getDaAdmin = (() => {
  let daAdmin;
  return (location) => {
    if (!location && daAdmin) return daAdmin;
    daAdmin = getDaEnv(location || window.location, 'da-admin', DA_ADMIN_ENVS);
    return daAdmin;
  };
})();

export const DA_ORIGIN = (() => getDaEnv(window.location, 'da-admin', DA_ADMIN_ENVS))();
export const COLLAB_ORIGIN = (() => getDaEnv(window.location, 'da-collab', DA_COLLAB_ENVS))();
export const CON_ORIGIN = (() => getDaEnv(window.location, 'da-content', DA_CONTENT_ENVS))();
export const LIVE_PREVIEW_DOMAIN = (() => getDaEnv(window.location, 'da-live-preview', DA_LIVE_PREVIEW_ENVS))();
export const DA_ETC_ORIGIN = (() => getDaEnv(window.location, 'da-etc', DA_ETC_ENVS))();

export function getLivePreviewUrl(owner, repo, branch = 'main') {
  const protocol = LIVE_PREVIEW_DOMAIN.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${branch}--${repo}--${owner}.${LIVE_PREVIEW_DOMAIN}`;
}
