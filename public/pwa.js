const appUrl = new URL('./index.html', window.location.href)
const appScopeUrl = new URL('./', window.location.href)
const serviceWorkerUrl = new URL('./sw.js', window.location.href)

/*
 * Dataverse web resources do not support a .webmanifest/.json resource type.
 * Generate the browser manifest in memory instead.
 *
 * Use absolute URLs because relative URLs in a data: manifest would be resolved
 * against the data URL rather than against the Dataverse web-resource folder.
 */
const manifest = {
  id: appUrl.href,
  name: 'Dataverse IDE',
  short_name: 'DV IDE',
  description: 'A browser IDE powered by monaco-vscode-api.',
  start_url: appUrl.href,
  scope: appScopeUrl.href,
  display: 'standalone',
  background_color: '#1f1f1f',
  theme_color: '#0078d4',

  icons: [
    {
      src: new URL(
        './icons/dataverse-ide-192.png',
        appScopeUrl,
      ).href,
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: new URL(
        './icons/dataverse-ide-512.png',
        appScopeUrl,
      ).href,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
  ],
}

if (document.querySelector('link[rel="manifest"]') == null) {
  const manifestLink = document.createElement('link')

  manifestLink.rel = 'manifest'
  manifestLink.type = 'application/manifest+json'
  manifestLink.href =
    `data:application/manifest+json;charset=utf-8,${encodeURIComponent(
      JSON.stringify(manifest),
    )}`

  document.head.appendChild(manifestLink)
}

if ('serviceWorker' in navigator) {
  const wasControlled = navigator.serviceWorker.controller != null
  let reloadedForInitialControl = false

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /*
     * A newly registered worker cannot control the document that registered it.
     * Reload once when the first worker takes control.
     */
    if (!wasControlled && !reloadedForInitialControl) {
      reloadedForInitialControl = true
      window.location.reload()
    }
  })


    const registration = navigator.serviceWorker.register(
      serviceWorkerUrl.href,
      {
        scope: appScopeUrl.pathname,
      },
    )
}