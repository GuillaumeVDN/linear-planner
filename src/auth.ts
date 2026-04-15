const LINEAR_AUTH_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const SCOPES = "read";
const AUTH_STORAGE_KEY = "linear-planner-auth";
const PKCE_STORAGE_KEY = "linear-planner-pkce";
const STATE_STORAGE_KEY = "linear-planner-oauth-state";

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateRandomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256(plain: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(plain);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function getClientId(): string {
  const id = import.meta.env.VITE_LINEAR_CLIENT_ID;
  if (!id) throw new Error("VITE_LINEAR_CLIENT_ID is not configured");
  return id;
}

function getRedirectUri(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/callback`;
}

export function getCallbackPath(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/callback`;
}

export async function startLogin(): Promise<void> {
  const codeVerifier = generateRandomString(32);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  const state = generateRandomString(16);

  sessionStorage.setItem(PKCE_STORAGE_KEY, codeVerifier);
  sessionStorage.setItem(STATE_STORAGE_KEY, state);

  const url = new URL(LINEAR_AUTH_URL);
  url.searchParams.set("client_id", getClientId());
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  window.location.href = url.toString();
}

export async function handleOAuthCallback(code: string, state: string): Promise<void> {
  const storedState = sessionStorage.getItem(STATE_STORAGE_KEY);
  if (!storedState || storedState !== state) {
    throw new Error("Invalid OAuth state parameter");
  }
  sessionStorage.removeItem(STATE_STORAGE_KEY);

  const codeVerifier = sessionStorage.getItem(PKCE_STORAGE_KEY);
  if (!codeVerifier) throw new Error("Missing PKCE code verifier");
  sessionStorage.removeItem(PKCE_STORAGE_KEY);

  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${body}`);
  }

  const data = await res.json();
  saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
}

async function refreshTokens(): Promise<AuthTokens> {
  const current = loadTokens();
  if (!current?.refreshToken) throw new Error("No refresh token available");

  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: getClientId(),
    }),
  });

  if (!res.ok) {
    clearTokens();
    throw new Error("Session expired — please sign in again");
  }

  const data = await res.json();
  const tokens: AuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

// Prevent concurrent refresh requests
let refreshPromise: Promise<AuthTokens> | null = null;

export async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated");

  // Proactively refresh if token expires within 5 minutes
  if (tokens.expiresAt - Date.now() < 5 * 60 * 1000) {
    if (!refreshPromise) {
      refreshPromise = refreshTokens().finally(() => { refreshPromise = null; });
    }
    const refreshed = await refreshPromise;
    return refreshed.accessToken;
  }

  return tokens.accessToken;
}

function saveTokens(tokens: AuthTokens): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tokens));
}

export function loadTokens(): AuthTokens | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.accessToken || !data.refreshToken) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return loadTokens() !== null;
}

export async function logout(): Promise<void> {
  const tokens = loadTokens();
  if (tokens) {
    try {
      await fetch(LINEAR_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.accessToken }),
      });
    } catch {
      // Ignore revocation errors
    }
  }
  clearTokens();
}
