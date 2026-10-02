import { dirname, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { previewFiles } from './scripts/preview-files'
import { PREVIEW_FILES, PREVIEW_PAGE } from './src/shared/preview-page'

/** pdfjs-dist's JavaScript decoders of pictures, which take the place of its WebAssembly. */
const PDFJS_DECODER = /^\w+_nowasm_fallback\.js$/

/**
 * Adds bundled-packages-<name>.json to the output of a bundle: the folders of the npm packages whose code
 * it took in, and the folders inside packages it copied files from as they are, such as pdf.js's decoders,
 * from which scripts/third-party-notices.mjs collects their licenses. The renderer and its workers take in
 * development dependencies such as Transformers.js, which package.json alone would not show. Each worker is a
 * bundle of its own, so the name comes from the bundle's entries.
 */
function bundledPackages(): Plugin {
  let root!: string
  return {
    name: 'bundled-packages',
    configResolved(config) {
      root = config.root
    },
    generateBundle(_options, bundle) {
      const dirs = new Set<string>()
      const entries: string[] = []
      for (const output of Object.values(bundle)) {
        if (output.type === 'asset') {
          for (const original of output.originalFileNames) {
            const file = resolve(root, original)
            if (/[\\/]node_modules[\\/]/.test(file)) dirs.add(dirname(file))
          }
          continue
        }
        if (output.isEntry) entries.push(output.name)
        for (const id of Object.keys(output.modules)) {
          // The last node_modules in the path is the package itself when one package nests another.
          const match = /^.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+/.exec(id.replace(/^\0/, ''))
          if (match) dirs.add(match[0])
        }
      }
      const name = entries.sort().join('-') || 'bundle'
      this.emitFile({ type: 'asset', fileName: `bundled-packages-${name}.json`, source: JSON.stringify([...dirs].sort(), null, 2) })
    }
  }
}

/**
 * The OAuth client of Google, embedded in the main process from the environment of the build or from .env.
 * CI passes them from its secrets to the jobs that package the app, and they are never in the repository.
 * An empty value builds an app whose calendar fails when it is first used, saying the client is missing.
 */
function googleClientDefines(mode: string): Record<string, string> {
  const env = loadEnv(mode, process.cwd(), 'ASIST_GOOGLE_')
  return {
    ASIST_GOOGLE_CLIENT_ID: JSON.stringify(env.ASIST_GOOGLE_CLIENT_ID ?? ''),
    ASIST_GOOGLE_CLIENT_SECRET: JSON.stringify(env.ASIST_GOOGLE_CLIENT_SECRET ?? '')
  }
}

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin(), bundledPackages()],
    define: googleClientDefines(mode),
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), bundledPackages()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    // The preview page, in whose iframe the viewers do their heavy work, is a second page of the renderer, and
    // main serves the files previewFiles lists for it and nothing else.
    plugins: [react(), tailwindcss(), bundledPackages(), previewFiles(PREVIEW_PAGE, PREVIEW_FILES)],
    worker: {
      plugins: () => [bundledPackages()]
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html'), preview: resolve('src/renderer/preview.html') },
        output: {
          // pdf.js imports its decoders of JBIG2, CCITT fax and JPEG 2000 pictures by their own names from one folder
          // (src/renderer/src/preview/methods/pdf.ts), so they keep their names.
          assetFileNames: ({ names }) => (names.some((name) => PDFJS_DECODER.test(name)) ? 'assets/pdfjs/[name][extname]' : 'assets/[name]-[hash][extname]')
        }
      }
    }
  }
}))
