/**
 * Production bundle for the SPA.
 *
 * Replaces `vite build`. The dev path does not go through this file at all —
 * the backend imports `index.html` directly and lets Bun's dev server bundle it
 * on demand with HMR (see `backend-ts/src/main.ts`), which is why there is no
 * watch mode here and no dev server to configure.
 *
 * Output layout is dictated by two consumers that already exist:
 *
 * - `backend-ts/src/http/static.ts` serves this directory, and
 *   `middleware/auth.ts` lets `/assets` through unauthenticated. Everything
 *   hashed therefore has to live under `assets/`, while `index.html` stays at
 *   the root where the SPA fallback looks for it.
 * - `frontend/vercel.json` rewrites all paths to `/index.html` for the split
 *   deployment, which wants the same shape.
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import tailwind from 'bun-plugin-tailwind'

const ROOT = import.meta.dir
const OUT_DIR = join(ROOT, 'dist')

/**
 * The API origin baked into the bundle.
 *
 * **This define is not optional.** Bun leaves an unmatched `process.env.X` in
 * the output verbatim, and `process` does not exist in a browser — so omitting
 * it does not fall back to the default, it throws on the first line of
 * `apiClient.ts` and the page renders white. Vite substituted this
 * automatically; Bun does not.
 *
 * The dev server substitutes the same read through `env` in `bunfig.toml`
 * instead, which is why `apiClient.ts` spells it `process.env` — see the note
 * there. The two mechanisms must keep naming the same variable.
 *
 * Empty is the normal value: both supported ways of running the app put the API
 * on the page's own origin, so the app issues relative URLs. Only the split
 * deployment (frontend on Vercel, backend behind a tunnel) sets it.
 */
const apiBaseUrl = process.env.VITE_API_BASE_URL ?? ''

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(ROOT, 'index.html')],
  outdir: OUT_DIR,
  target: 'browser',
  plugins: [tailwind],
  minify: true,
  sourcemap: 'linked',
  // The lazy panels in `GameStatePanel.tsx` are real `React.lazy` boundaries.
  // Without this they are inlined into the entry chunk and the split is lost.
  splitting: true,
  naming: {
    entry: '[name].[ext]',
    chunk: 'assets/[name]-[hash].[ext]',
    asset: 'assets/[name]-[hash].[ext]',
  },
  define: {
    'process.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

for (const log of result.logs) console.error(String(log))

if (!result.success) {
  console.error('✗ build failed')
  process.exit(1)
}

const bytes = result.outputs.reduce((sum, output) => sum + output.size, 0)
const shipped = result.outputs.filter((output) => output.kind !== 'sourcemap')
for (const output of shipped.sort((a, b) => b.size - a.size).slice(0, 8)) {
  const name = output.path.slice(OUT_DIR.length + 1)
  console.log(`  ${(output.size / 1024).toFixed(1).padStart(8)} kb  ${name}`)
}
console.log(`✓ built ${shipped.length} files (${(bytes / 1024 / 1024).toFixed(2)} mb incl. sourcemaps) → ${OUT_DIR}`)
