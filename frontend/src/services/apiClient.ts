/**
 * Base URL every request is built on.
 *
 * Empty string by default, i.e. same-origin relative URLs. Both supported ways
 * of running the app put the API on the page's own origin — the backend bundles
 * this app in-process in dev (see `backend-ts/src/http/serve.ts`) and serves the
 * built bundle in the single-port build (see
 * `backend-ts/src/http/static.ts`) — so the app does not need to know a host,
 * and stops being wrong when it is reached over a LAN IP, a tunnel or a
 * forwarded port.
 *
 * `VITE_API_BASE_URL` overrides it for the split deployment, where the frontend
 * is on Vercel and the backend behind a Cloudflare tunnel and the two genuinely
 * do have different origins. It is substituted at bundle time and never read at
 * runtime, because `process` does not exist in a browser.
 *
 * It has to be spelled `process.env.X`, not `import.meta.env.X`. Only the first
 * form can be substituted in *both* ways this app is bundled: `Bun.build` takes
 * either through `define`, but the dev server has no `define` — it inlines
 * `process.env` matches of the `env` glob in `bunfig.toml` and nothing else, and
 * rewrites `import.meta` to an HMR shim whose `.env` is undefined. That mismatch
 * is what made `make dev` throw here while the build was fine.
 */
function getApiUrl(): string {
  const configured = process.env.VITE_API_BASE_URL;
  if (!configured) return "";

  try {
    const parsed = new URL(configured);
    // Strip any credentials embedded in the URL; auth is the API key now.
    parsed.username = "";
    parsed.password = "";
    // Trailing slash would double up against the leading slash of every path.
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return configured.replace(/\/$/, "");
  }
}

export const API_BASE_URL = getApiUrl();

// Global API key storage
let globalApiKey: string | null = null;

/**
 * Set the API key to be used for all API requests.
 * This should be called by the AuthContext when the user logs in.
 */
export function setApiKey(key: string | null) {
  globalApiKey = key;
}

/**
 * Get the current API key.
 */
export function getApiKey(): string | null {
  return globalApiKey;
}

/**
 * Helper to create fetch options with API key and common headers.
 */
export function getFetchOptions(options: RequestInit = {}): RequestInit {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  // Add API key header if available
  if (globalApiKey) {
    headers["X-API-Key"] = globalApiKey;
  }

  // Add ngrok header to skip browser warning page
  headers["ngrok-skip-browser-warning"] = "true";

  return {
    ...options,
    headers,
  };
}
