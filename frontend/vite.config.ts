import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'
import type { PluginOption } from 'vite'

/**
 * Top-level paths owned by the backend rather than by the SPA.
 *
 * Kept in step with `API_PREFIXES` in `backend-ts/src/http/static.ts` — the two
 * lists answer the same question from opposite ends (which paths are *not* the
 * app), and a prefix added on one side but not the other shows up as a 404 in
 * exactly one of the two run modes.
 *
 * Anchored regexes rather than Vite's plain-string prefixes so `/agents` cannot
 * swallow `/agent-configs`.
 */
const API_PREFIXES = [
  'auth',
  'worlds',
  'rooms',
  'messages',
  'agents',
  'agent-configs',
  'readme',
  'debug',
  'mcp',
  // Separate from `mcp` because these keys are anchored regexes: `^/mcp(/|$)`
  // does not match `/mcp-tools`. `API_PREFIXES` in `static.ts` matches by plain
  // prefix, so one entry covers both there.
  'mcp-tools',
]

/**
 * Forward the API to the backend so a developer only ever opens 5173.
 *
 * Same-origin in dev is not just convenience: it means CORS, cookie scope and
 * the SSE stream behave here the way they do in the single-port production
 * build, instead of being exercised for the first time after `bun run build`.
 */
function apiProxy(target: string) {
  return Object.fromEntries(
    API_PREFIXES.map((prefix) => [
      `^/${prefix}(/|$)`,
      {
        target,
        changeOrigin: true,
        // The SSE stream is a long-lived response; http-proxy passes chunks
        // through as they arrive, but the socket must be allowed to stay open.
        timeout: 0,
        proxyTimeout: 0,
      },
    ]),
  )
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [react()]

  // Add bundle analyzer when building with --mode analyze
  if (mode === 'analyze') {
    plugins.push(
      visualizer({
        open: true,
        filename: 'dist/bundle-stats.html',
        gzipSize: true,
        brotliSize: true,
        template: 'treemap', // 'sunburst' | 'treemap' | 'network'
      }) as PluginOption
    )
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: 'localhost',
      port: 5173,
      proxy: apiProxy(process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'),
    },
    build: {
      // Optimize chunk splitting for better caching
      rollupOptions: {
        output: {
          manualChunks: {
            // Split vendor libraries into separate chunks
            'react-vendor': ['react', 'react-dom'],
            'ui-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-tooltip'],
            'markdown': ['react-markdown', 'remark-gfm', 'remark-breaks'],
            'i18n': ['i18next', 'react-i18next'],
            'virtuoso': ['react-virtuoso'],
          },
        },
      },
    },
  }
})
