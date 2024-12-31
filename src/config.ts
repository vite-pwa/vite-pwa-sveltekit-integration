import { resolve } from 'node:path'
import type { ResolvedConfig } from 'vite'
import type { VitePWAOptions } from 'vite-plugin-pwa'
import type { ManifestEntry, ManifestTransform } from 'workbox-build'
import type { KitOptions } from './types'

export function configureSvelteKitOptions(
  kit: KitOptions,
  viteOptions: ResolvedConfig,
  options: Partial<VitePWAOptions>,
) {
  const {
    base = viteOptions.base ?? '/',
    adapterFallback,
    outDir = `${viteOptions.root}/.svelte-kit`,
    assets = 'static',
  } = kit

  // Vite will copy public folder to the globDirectory after pwa plugin runs:
  // globDirectory is the build folder.
  // SvelteKit will copy to the globDirectory before pwa plugin runs (via Vite client build in writeBundle hook):
  // globDirectory is the kit client output folder.
  // We need to disable includeManifestIcons: any icon in the static folder will be twice in the sw's precache manifest.
  if (typeof options.includeManifestIcons === 'undefined')
    options.includeManifestIcons = false

  let config: Partial<
    import('workbox-build').BasePartial
    & import('workbox-build').GlobPartial
    & import('workbox-build').RequiredGlobDirectoryPartial
  >

  if (options.strategies === 'injectManifest') {
    if (!options.srcDir)
      options.srcDir = 'src'

    if (!options.filename)
      options.filename = 'service-worker.js'

    options.injectManifest = options.injectManifest ?? {}
    config = options.injectManifest
  }
  else {
    options.workbox = options.workbox ?? {}
    // the user may want to disable offline support
    if (!('navigateFallback' in options.workbox))
      options.workbox.navigateFallback = adapterFallback ?? base

    config = options.workbox
  }

  // SvelteKit outDir is `.svelte-kit/output/client`.
  // We need to include the parent folder since SvelteKit will generate SSG in `.svelte-kit/output/prerendered` folder.
  if (!config.globDirectory)
    config.globDirectory = `${outDir}/output`

  let buildAssetsDir = kit.appDir ?? '_app/'
  if (buildAssetsDir[0] === '/')
    buildAssetsDir = buildAssetsDir.slice(1)
  if (buildAssetsDir[buildAssetsDir.length - 1] !== '/')
    buildAssetsDir += '/'

  if (!config.modifyURLPrefix) {
    config.globPatterns = buildGlobPatterns(config.globPatterns)
    if (kit.includeVersionFile)
      config.globPatterns.push(`client/${buildAssetsDir}version.json`)
  }

  // exclude server assets: sw is built on SSR build
  config.globIgnores = buildGlobIgnores(config.globIgnores)

  // Vite 5 support: allow override dontCacheBustURLsMatching
  if (!('dontCacheBustURLsMatching' in config))
    config.dontCacheBustURLsMatching = new RegExp(`${buildAssetsDir}immutable/`)

  if (!config.manifestTransforms) {
    config.manifestTransforms = [createManifestTransform(
      base,
      config.globDirectory,
      options.strategies === 'injectManifest'
        ? undefined
        : (options.manifestFilename ?? 'manifest.webmanifest'),
      kit,
    )]
  }

  if (options.pwaAssets) {
    options.pwaAssets.integration = {
      baseUrl: base,
      publicDir: resolve(viteOptions.root, assets),
      outDir: resolve(outDir, 'output/client'),
    }
  }
}

function createManifestTransform(
  base: string,
  outDir: string,
  webManifestName?: string,
  options?: KitOptions,
): ManifestTransform {
  return async (entries) => {
    const defaultAdapterFallback = 'prerendered/fallback.html'
    const suffix = options?.trailingSlash === 'always' ? '/' : ''
    let adapterFallback = options?.adapterFallback
    let excludeFallback = false
    // the fallback will be always generated by SvelteKit.
    // The adapter will copy the fallback only if it is provided in its options: we need to exclude it
    if (!adapterFallback) {
      adapterFallback = defaultAdapterFallback
      excludeFallback = true
    }

    // the fallback will be always in .svelte-kit/output/prerendered/fallback.html
    const manifest = entries
      .filter(({ url }) => !(excludeFallback && url === defaultAdapterFallback))
      .map((e) => {
        let url = e.url
        // client assets in `.svelte-kit/output/client` folder.
        // SSG pages in `.svelte-kit/output/prerendered/pages` folder.
        // SPA pages in `.svelte-kit/output/prerendered/dependencies/` folder.
        // static adapter with load functions in `.svelte-kit/output/prerendered/dependencies/<page>/_data.json`.
        // fallback page in `.svelte-kit/output/prerendered` folder (fallback.html is the default).
        if (url.startsWith('client/'))
          url = url.slice(7)
        else if (url.startsWith('prerendered/dependencies/'))
          url = url.slice(25)
        else if (url.startsWith('prerendered/pages/'))
          url = url.slice(18)
        else if (url === defaultAdapterFallback)
          url = adapterFallback!

        if (url.endsWith('.html')) {
          if (url.startsWith('/'))
            url = url.slice(1)

          if (url === 'index.html') {
            url = base
          }
          else {
            const idx = url.lastIndexOf('/')
            if (idx > -1) {
            // abc/index.html -> abc/?
              if (url.endsWith('/index.html'))
                url = `${url.slice(0, idx)}${suffix}`
              // abc/def.html -> abc/def/?
              else
                url = `${url.substring(0, url.lastIndexOf('.'))}${suffix}`
            }
            else {
            // xxx.html -> xxx/?
              url = `${url.substring(0, url.lastIndexOf('.'))}${suffix}`
            }
          }
        }

        e.url = url

        return e
      })

    if (options?.spa && options?.adapterFallback) {
      const name = typeof options.spa === 'object' && options.spa.fallbackMapping
        ? options.spa.fallbackMapping
        : options.adapterFallback
      if (typeof options.spa === 'object' && typeof options.spa.fallbackRevision === 'function') {
        manifest.push({
          url: name,
          revision: await options.spa.fallbackRevision(),
          size: 0,
        })
      }
      else {
        manifest.push(await buildManifestEntry(
          name,
          resolve(outDir, 'client/_app/version.json'),
        ))
      }
    }

    if (!webManifestName)
      return { manifest }

    return { manifest: manifest.filter(e => e.url !== webManifestName) }
  }
}

function buildGlobPatterns(globPatterns?: string[]) {
  if (globPatterns) {
    if (!globPatterns.some(g => g.startsWith('prerendered/')))
      globPatterns.push('prerendered/**/*.{html,json,js}')

    if (!globPatterns.some(g => g.startsWith('client/')))
      globPatterns.push('client/**/*.{js,css,ico,png,svg,webp,webmanifest}')

    if (!globPatterns.some(g => g.includes('webmanifest')))
      globPatterns.push('client/*.webmanifest')

    return globPatterns
  }

  return ['client/**/*.{js,css,ico,png,svg,webp,webmanifest}', 'prerendered/**/*.{html,json,js}']
}

function buildGlobIgnores(globIgnores?: string[]) {
  if (globIgnores) {
    if (!globIgnores.some(g => g.startsWith('server/')))
      globIgnores.push('server/**')

    return globIgnores
  }

  return ['server/**']
}

async function buildManifestEntry(url: string, path: string): Promise<ManifestEntry & { size: number }> {
  const [crypto, createReadStream] = await Promise.all([
    import('node:crypto').then(m => m.default),
    import('node:fs').then(m => m.createReadStream),
  ])

  return new Promise((resolve, reject) => {
    const cHash = crypto.createHash('MD5')
    const stream = createReadStream(path)
    stream.on('error', (err) => {
      reject(err)
    })
    stream.on('data', (chunk) => {
      // @ts-expect-error TS2345: Argument of type string | Buffer is not assignable to parameter of type BinaryLike
      cHash.update(chunk)
    })
    stream.on('end', () => {
      return resolve({
        url,
        size: 0,
        revision: `${cHash.digest('hex')}`,
      })
    })
  })
}
