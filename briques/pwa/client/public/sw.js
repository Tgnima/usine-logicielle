// Le service worker : l'application s'ouvre même sans réseau.
// - les fichiers de l'interface (/assets/…, versionnés par Vite) : du cache d'abord ;
// - les pages : le réseau d'abord, la dernière page connue en secours ;
// - /api et /_portier : jamais en cache (données privées, connexion).
const VERSION = "v1"
const CACHE = `appli-${VERSION}`

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  )
})

const gardable = (r) => r && r.ok && r.type === "basic" && !r.redirected

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== "GET" || url.origin !== location.origin) return
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_portier/")) return

  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (gardable(r)) {
            const copie = r.clone()
            caches.open(CACHE).then((c) => c.put("/", copie))
          }
          return r
        })
        .catch(() => caches.match("/").then((r) => r ?? Response.error())),
    )
    return
  }

  if (url.pathname.startsWith("/assets/") || url.pathname === "/icone.svg") {
    e.respondWith(
      caches.match(e.request).then(
        (enCache) =>
          enCache ??
          fetch(e.request).then((r) => {
            if (gardable(r)) {
              const copie = r.clone()
              caches.open(CACHE).then((c) => c.put(e.request, copie))
            }
            return r
          }),
      ),
    )
  }
})
