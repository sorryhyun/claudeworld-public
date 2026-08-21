/**
 * Base URL every request is built on.
 *
 * Empty string by default, i.e. same-origin relative URLs. Both supported ways
 * of running the app put the API on the page's own origin — Vite proxies the
 * API prefixes to the backend in dev (see `vite.config.ts`), and the backend
 * serves this bundle itself in the single-port build (see
 * `backend-ts/src/http/static.ts`) — so the app does not need to know a host,
 * and stops being wrong when it is reached over a LAN IP, a tunnel or a
 * forwarded port.
 *
 * `VITE_API_BASE_URL` overrides it for the split deployment, where the frontend
 * is on Vercel and the backend behind a Cloudflare tunnel and the two genuinely
 * do have different origins.
 */
function getApiUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
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
