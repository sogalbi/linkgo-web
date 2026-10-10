/**
 * LINKGO's service worker.
 *
 * It exists for two reasons, in this order:
 *
 *   1. Chrome will not offer to install a PWA — and therefore will not register
 *      the `share_target` in `manifest.json` — unless the page controls a
 *      service worker with a `fetch` handler. Without this file there is no
 *      "Add to Home screen", and without that there is no LINKGO in the
 *      Android share sheet.
 *   2. A share that arrives with no network must still reach the app. The
 *      capture screen queues to disk and syncs later, but only if the shell
 *      loads at all. Serving `/index.html` from cache is what makes an offline
 *      share a saved link instead of a browser error page.
 *
 * It is deliberately not a Workbox build. The whole policy is eight lines, and
 * a generated worker is one more thing that can cache a stale bundle nobody can
 * clear.
 */

/**
 * Bump this to evict every previously cached response.
 *
 * Only needed when the *policy* below changes. Bundle updates are handled by
 * the hashes Metro puts in asset filenames — a new build requests new URLs, so
 * old entries are simply never asked for again.
 */
const CACHE = 'linkgo-v2';

/**
 * Where the app is served from — `/` at a domain root, `/linkgo/` on a GitHub
 * Pages project site.
 *
 * Derived from this file's own URL rather than hardcoded, because the worker is
 * always served from the deployment root: whatever prefix precedes `sw.js` is
 * the prefix for everything else. That keeps the one path assumption in this
 * file self-correcting instead of something a sub-path deploy silently breaks.
 */
const BASE = self.location.pathname.replace(/sw\.js$/, '');

/**
 * The SPA shell. It is the response for every route, so caching this one entry
 * makes the entire app available offline.
 */
const SHELL = `${BASE}index.html`;

const PRECACHE = [
  SHELL,
  `${BASE}manifest.json`,
  `${BASE}icons/icon-192.png`,
  `${BASE}icons/icon-512.png`,
  `${BASE}icons/badge-96.png`,
];

self.addEventListener('install', (event) => {
  // Take over on the first load rather than on the next one. A user who just
  // installed the app and immediately shares a link is the common case, and
  // waiting for a second visit would miss it.
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing icon cannot fail the whole install and
      // leave the app permanently uninstallable.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Write to the cache without ever letting the failure escape.
 *
 * `Cache.put` rejects on a response the cache refuses to store (a 206, an
 * opaque cross-origin response), and these writes are deliberately not awaited
 * — the response has already been handed to the page. An uncaught rejection
 * here surfaces as an error in the worker for something that only costs a cache
 * miss.
 */
function putInCache(key, response) {
  void caches
    .open(CACHE)
    .then((cache) => cache.put(key, response))
    .catch(() => undefined);
}

function cacheShell(response) {
  putInCache(SHELL, response);
}

// ---------------------------------------------------------------------------
// "다시 보기" reminders (migration 0016)
// ---------------------------------------------------------------------------
//
// The server (`send-reminders`) pushes `{ title, body, path, tag }`, encrypted
// to this browser. Anything else in a push is ignored rather than shown: the
// push service relays it, and a notification is the one thing a page cannot
// take back.

const ITEM_PATH = /^item\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readReminder(data) {
  let value = {};
  try {
    value = data ? data.json() : {};
  } catch {
    value = {};
  }
  const text = (field, max) =>
    typeof value[field] === 'string' ? value[field].slice(0, max) : '';
  return {
    title: text('title', 120) || 'LINKGO',
    body: text('body', 240),
    // Only the app's own item route, or the library: never an arbitrary URL.
    path: ITEM_PATH.test(value.path) ? value.path : '',
    tag: text('tag', 64) || 'linkgo',
  };
}

self.addEventListener('push', (event) => {
  const reminder = readReminder(event.data);
  event.waitUntil(
    self.registration.showNotification(reminder.title, {
      body: reminder.body,
      tag: reminder.tag,
      icon: `${BASE}icons/icon-192.png`,
      // Android draws the badge from its alpha channel alone; a full-colour
      // icon there becomes a white square in the status bar.
      badge: `${BASE}icons/badge-96.png`,
      lang: 'ko',
      data: { path: reminder.path },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || '';
  const target = new URL(`${BASE}${ITEM_PATH.test(path) ? path : ''}`, self.location.origin).href;

  // An open LINKGO window is reused — focused, then sent to the link — so a
  // tap never stacks a second copy of the app.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const app = windows.find((client) => new URL(client.url).pathname.startsWith(BASE));
      if (app) {
        await app.focus();
        if ('navigate' in app) await app.navigate(target).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations — including `/share?url=...` arriving from the OS share sheet.
  // Network first, because the shell is the one document that must not go
  // stale, with the cached copy as the offline answer. The request URL is
  // unchanged by serving the shell, so the query string the share target put
  // there is still readable by the app.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // `response.ok` is the important part, not a formality. Without it a
          // 404 or a 503 from a mid-flight deploy is stored as the shell, and
          // every later offline navigation — including a share arriving from
          // the OS share sheet — is answered with that error page instead of
          // the app. The capture screen would never mount and the link would
          // never reach the disk queue, which is the one failure this product
          // does not allow.
          if (response.ok) cacheShell(response.clone());
          return response;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Everything else is a hashed bundle or an image: the URL changes whenever
  // the bytes do, so a hit is always current.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            putInCache(request, response.clone());
          }
          return response;
        }),
    ),
  );
});
