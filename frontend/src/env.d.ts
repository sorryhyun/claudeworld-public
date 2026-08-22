/**
 * Build-time environment baked into the bundle.
 *
 * `frontend/build.ts` substitutes `import.meta.env.VITE_API_BASE_URL` with a
 * literal via Bun's `define`. Nothing reads this object at runtime — in a
 * browser `import.meta.env` does not exist, so any property left unsubstituted
 * would throw rather than read as undefined.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
