const cacheName = "neovid-v1.5";
const appShell = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "recent-store.js",
  "site.webmanifest",
  "assets/apple-touch-icon.png",
  "assets/logo.png",
  "assets/og-preview.png",
  "assets/web-app-manifest-192x192.png",
  "assets/web-app-manifest-512x512.png",
  "assets/favicon/favicon.svg",
  "assets/favicon/favicon.ico",
  "assets/favicon/favicon-96x96.png",
  "libs/sweetalert2/sweetalert2.min.css",
  "libs/sweetalert2/sweetalert2.min.js",
  "libs/fontawesome/css/all.min.css",
  "libs/fontawesome/webfonts/fa-brands-400.woff2",
  "libs/fontawesome/webfonts/fa-regular-400.woff2",
  "libs/fontawesome/webfonts/fa-solid-900.woff2",
  "libs/fontawesome/webfonts/fa-v4compatibility.woff2",
];


self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(cacheName).then(cache => cache.addAll(appShell))
  );
});


self.addEventListener("activate", event => {
  // Remove every cache created by an older service-worker version.
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== cacheName)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});


self.addEventListener("fetch", event => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;


  if (request.mode === "navigate") {
    // Network-first: serve the freshest homepage while online and fall
    // back to the cached copy when the network is unavailable.
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(cacheName).then(cache => cache.put("index.html", copy));
          return response;
        })
        .catch(() => caches.match("index.html"))
    );
    return;
  }


  event.respondWith(
    caches.match(request).then(cached => {
      return (
        cached ||
        fetch(request).then(response => {
          caches.open(cacheName).then(cache => {
            cache.put(request, response.clone());
          });
          return response;
        })
      );
    })
  );
});



self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
