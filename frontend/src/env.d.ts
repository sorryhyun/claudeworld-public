/**
 * Build-time environment baked into the bundle.
 *
 * `VITE_API_BASE_URL` is substituted as a literal — by `define` in
 * `frontend/build.ts`, and by the `env` glob in `bunfig.toml` for the dev
 * server. Nothing reads `process` at runtime: it does not exist in a browser,
 * so a property left unsubstituted would throw rather than read as undefined.
 *
 * Declared narrowly here rather than pulled in from `@types/node`, which would
 * put the whole Node API on a browser bundle's autocomplete.
 */
declare const process: {
  readonly env: {
    readonly VITE_API_BASE_URL?: string;
    readonly NODE_ENV?: string;
  };
};
