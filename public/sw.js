const CACHE_NAME = 'dataverse-ide-runtime-v3'

const scopeUrl = new URL(self.registration.scope)
const indexUrl = new URL('./index.html', scopeUrl).href

function isAppResource(url) {
  return (
    url.origin === self.location.origin &&
    url.href.startsWith(self.registration.scope)
  )
}

function isCacheableResponse(response) {
  return response != null && response.ok
}

function withIsolationHeaders(response) {
  const headers = new Headers(response.headers)

  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function putInCache(request, response) {
  if (!isCacheableResponse(response)) {
    return
  }

  const cache = await caches.open(CACHE_NAME)
  await cache.put(request, response.clone())
}

async function precacheIfAvailable(cache, url) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
    })

    if (!response.ok) {
      console.warn(
        '[Dataverse IDE] Skipping failed precache request:',
        url,
        response.status,
      )
      return
    }

    await cache.put(url, response)
  } catch (error) {
    console.warn(
      '[Dataverse IDE] Skipping unavailable precache request:',
      url,
      error,
    )
  }
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request)

    if (isCacheableResponse(response)) {
      await putInCache(request, response)
    }

    return withIsolationHeaders(response)
  } catch (error) {
    const cache = await caches.open(CACHE_NAME)

    const cachedResponse =
      (await cache.match(request)) ??
      (await cache.match(indexUrl))

    if (cachedResponse != null) {
      return withIsolationHeaders(cachedResponse)
    }

    throw error
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_NAME)
  const cachedResponse = await cache.match(request)

  const networkUpdate = fetch(request)
    .then(async (response) => {
      if (isCacheableResponse(response)) {
        await cache.put(request, response.clone())
      }

      return response
    })
    .catch(() => undefined)

  event.waitUntil(networkUpdate)

  if (cachedResponse != null) {
    return cachedResponse
  }

  const networkResponse = await networkUpdate

  if (networkResponse != null) {
    return networkResponse
  }

  return new Response('Resource unavailable.', {
    status: 503,
    statusText: 'Service Unavailable',
  })
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)

      /*
       * Do not use cache.addAll().
       *
       * cache.addAll() rejects the entire installation when even one resource
       * fails. Dataverse redirects unsupported resource types to authentication,
       * which caused the prior service-worker installation failure.
       */
      await precacheIfAvailable(cache, indexUrl)

      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys()

      await Promise.all(
        cacheNames
          .filter(
            (cacheName) =>
              cacheName.startsWith('dataverse-ide-runtime-') &&
              cacheName !== CACHE_NAME,
          )
          .map((cacheName) => caches.delete(cacheName)),
      )

      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  /*
   * Do not cache Dataverse API operations, auth requests, external resources,
   * form submissions, or unrelated Dataverse web resources.
   */
  if (request.method !== 'GET' || !isAppResource(url)) {
    return
  }

  /*
   * Network-first ensures an updated index.html is used after deployment.
   * Cached index.html is retained as the offline/failure fallback.
   */
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  /*
   * Vite chunks, Monaco workers, extension-host files, icons, CSS, and other
   * static same-origin application resources load from cache when available,
   * while a background request refreshes the cache.
   */
  event.respondWith(staleWhileRevalidate(request, event))
})