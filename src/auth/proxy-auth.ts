/**
 * Proxy access control — dashboard session auth + API key/Basic auth.
 * NOT related to Google OAuth2 account management.
 */

// --- Config from env ---

export interface ProxyAuthConfig {
  username: string;
  password: string;
  apiKey: string;
  sessionTtlMs: number;
  cookieName: string;
}

export function getAuthConfig(): ProxyAuthConfig {
  return {
    username: process.env.PROXY_USERNAME || "admin",
    password: process.env.PROXY_PASSWORD || "",
    apiKey: process.env.PROXY_API_KEY || "",
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    cookieName: "ag_session",
  };
}

/** Returns true if auth is configured (password is set). If no password, auth is disabled. */
export function isAuthEnabled(): boolean {
  return getAuthConfig().password.length > 0;
}

// --- Session store (in-memory) ---

interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createSession(): string {
  const config = getAuthConfig();
  const token = generateToken();
  const now = Date.now();
  sessions.set(token, {
    token,
    createdAt: now,
    expiresAt: now + config.sessionTtlMs,
  });
  return token;
}

export function validateSession(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

// --- Cookie helpers ---

export function getSessionCookie(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  const config = getAuthConfig();
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${config.cookieName}=`));
  return match ? match.split("=")[1] : null;
}

export function setSessionCookieHeader(token: string): string {
  const config = getAuthConfig();
  return `${config.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`;
}

export function clearSessionCookieHeader(): string {
  const config = getAuthConfig();
  return `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// --- Credential validation ---

export function validateCredentials(username: string, password: string): boolean {
  const config = getAuthConfig();
  return username === config.username && password === config.password;
}

export function validateApiKey(key: string): boolean {
  const config = getAuthConfig();
  if (!config.apiKey) return false;
  return key === config.apiKey;
}

// --- Auth checks for routes ---

/** Check if request has valid dashboard session cookie */
export function hasDashboardAuth(req: Request): boolean {
  const token = getSessionCookie(req);
  return token !== null && validateSession(token);
}

/** Check if request has valid API auth (API key via header/query, or Basic Auth) */
export function hasApiAuth(req: Request): boolean {
  const config = getAuthConfig();
  const url = new URL(req.url);

  // 1. Bearer token / API key in Authorization header
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (config.apiKey && token === config.apiKey) return true;
  }

  // 2. Basic Auth
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      const [user, pass] = decoded.split(":");
      if (validateCredentials(user, pass)) return true;
    } catch {}
  }

  // 3. API key in query param
  const queryKey = url.searchParams.get("api_key");
  if (queryKey && config.apiKey && queryKey === config.apiKey) return true;

  // 4. API key in x-api-key header
  const headerKey = req.headers.get("x-api-key");
  if (headerKey && config.apiKey && headerKey === config.apiKey) return true;

  // 5. Also accept valid session cookie (dashboard user hitting API endpoints)
  if (hasDashboardAuth(req)) return true;

  return false;
}

/** Returns 401 JSON response for API endpoints */
export function apiUnauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Unauthorized. Provide a valid API key (Bearer token, x-api-key header, or api_key query param) or Basic Auth credentials.",
        type: "authentication_error",
        code: "unauthorized",
      },
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "WWW-Authenticate": 'Bearer realm="antigravity-proxy"',
      },
    }
  );
}

/** Returns redirect to login page for dashboard */
export function dashboardUnauthorized(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: "/frontend/login.html" },
  });
}
