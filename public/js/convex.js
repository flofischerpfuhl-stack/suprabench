// ══════════════════════════════════════════
// Convex Client + Auth (Vanilla JS)
// Ported from @convex-dev/auth React client
// ══════════════════════════════════════════

// ── Backend URLs ─────────────────────────────────────────────
// Dev deployment (used on localhost).
// Prod deployment (used on every other host, i.e. *.pages.dev and
// suprabench.com). After `npx convex deploy` for the first time,
// replace PROD_CONVEX_URL + PROD_CONVEX_SITE with the output URLs.
const DEV_CONVEX_URL  = "https://different-viper-119.convex.cloud";
const DEV_CONVEX_SITE = "https://different-viper-119.convex.site";
const PROD_CONVEX_URL  = "https://upbeat-clam-790.convex.cloud";
const PROD_CONVEX_SITE = "https://upbeat-clam-790.convex.site";

const _isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
   window.location.hostname === "127.0.0.1");

const CONVEX_URL      = _isLocal ? DEV_CONVEX_URL  : PROD_CONVEX_URL;
const CONVEX_SITE_URL = _isLocal ? DEV_CONVEX_SITE : PROD_CONVEX_SITE;

// Storage keys (must match @convex-dev/auth convention)
const NAMESPACE = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");
const VERIFIER_KEY = `__convexAuthOAuthVerifier_${NAMESPACE}`;
const JWT_KEY = `__convexAuthJWT_${NAMESPACE}`;
const REFRESH_KEY = `__convexAuthRefreshToken_${NAMESPACE}`;
// Where to return after OAuth round-trip (Google strips the URL fragment).
const RETURN_HASH_KEY = `__sbAuthReturnHash_${NAMESPACE}`;

// ── Initialize Convex Client ──
const ConvexClient = window.convex.ConvexClient;
const client = new ConvexClient(CONVEX_URL);
const api = window.convex.anyApi;

// ── Token State ──
let _currentToken = null;

async function _applyToken(token) {
  _currentToken = token;
  if (!token) return;

  // ConvexClient.setAuth returns a promise that resolves once the new
  // auth has actually been pushed to the server and existing subscriptions
  // are re-running with the new identity. We await it so callers know
  // when auth is fully active.
  await client.setAuth(
    () => Promise.resolve(token),
    (isAuthenticated) => {
      window.dispatchEvent(
        new CustomEvent("sb-auth-change", { detail: { isAuthenticated } })
      );
    }
  );
  // Always emit at least one event so listeners can sync state, even if
  // the convex client doesn't fire its onChange immediately.
  window.dispatchEvent(
    new CustomEvent("sb-auth-change", { detail: { isAuthenticated: true } })
  );
}

// ── Auth Flow: signIn ──
// Step 1: Call "auth:signIn" with provider → get redirect URL + verifier
// Step 2 (after OAuth redirect back): Call "auth:signIn" with code + verifier → get tokens
async function signIn(provider, params) {
  const verifier = localStorage.getItem(VERIFIER_KEY) || undefined;
  localStorage.removeItem(VERIFIER_KEY);

  const callParams = {};
  if (provider) callParams.provider = provider;
  if (params) callParams.params = params;
  if (verifier) callParams.verifier = verifier;

  // Use an unauthenticated HTTP client for the signIn action
  // (same as the React client does for code verification)
  const ConvexHttpClient = window.convex.ConvexHttpClient;
  const httpClient = new ConvexHttpClient(CONVEX_URL);

  let result;
  try {
    result = await httpClient.action(api.auth.signIn, callParams);
  } catch (e) {
    console.error("[Auth] signIn action failed:", e);
    throw e;
  }

  if (result.redirect) {
    // OAuth flow: store verifier + current location, redirect to provider.
    // Google strips the URL fragment, so we have to remember where the user was
    // and restore it after the code-exchange completes.
    localStorage.setItem(VERIFIER_KEY, result.verifier);
    try {
      const h = window.location.hash || "#submit";
      localStorage.setItem(RETURN_HASH_KEY, h);
    } catch (e) { /* ignore */ }
    window.location.href = result.redirect;
    return { signingIn: false, redirect: result.redirect };
  }

  if (result.tokens) {
    // Got tokens — store and apply (await so subscriptions reflect new auth)
    localStorage.setItem(JWT_KEY, result.tokens.token);
    localStorage.setItem(REFRESH_KEY, result.tokens.refreshToken);
    await _applyToken(result.tokens.token);
    return { signingIn: true };
  }

  return { signingIn: false };
}

// ── Auth Flow: signOut ──
async function signOut() {
  try {
    await client.action(api.auth.signOut);
  } catch (e) {
    // Ignore — usually means already signed out
  }
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(REFRESH_KEY);
  _currentToken = null;
  // Clear auth on the client too so subscriptions re-run unauthenticated.
  try { await client.setAuth(() => Promise.resolve(null)); } catch (e) { /* ignore */ }
  window.dispatchEvent(new CustomEvent("sb-auth-change", { detail: { isAuthenticated: false } }));
}

// ── Handle OAuth Callback ──
// Called on page load: checks for ?code= in the URL
async function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");

  if (code) {
    // Restore where the user was before the OAuth redirect.
    let returnHash = "";
    try { returnHash = localStorage.getItem(RETURN_HASH_KEY) || ""; } catch (e) {}
    try { localStorage.removeItem(RETURN_HASH_KEY); } catch (e) {}

    // Clean URL immediately (strip ?code=&state=) and put the user back
    // onto the view they came from (fallback: #submit, since that's the only
    // place the Sign-in button lives today).
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    const finalHash = returnHash || window.location.hash || "#submit";
    window.history.replaceState({}, "", url.pathname + url.search + finalHash);

    // Exchange code + stored verifier for tokens
    try {
      await signIn(undefined, { code });
    } catch (e) {
      console.error("[Auth] Code exchange failed:", e);
    }
    // Tell the app the hash changed so it re-renders the right view.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return true;
  }
  return false;
}

// ── Restore Session from Storage ──
async function restoreSession() {
  const storedToken = localStorage.getItem(JWT_KEY);
  if (storedToken) {
    await _applyToken(storedToken);
    return true;
  }
  return false;
}

// ── Refresh Token ──
async function refreshSession() {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;

  try {
    const ConvexHttpClient = window.convex.ConvexHttpClient;
    const httpClient = new ConvexHttpClient(CONVEX_URL);
    const result = await httpClient.action(api.auth.signIn, { refreshToken });
    if (result.tokens) {
      localStorage.setItem(JWT_KEY, result.tokens.token);
      localStorage.setItem(REFRESH_KEY, result.tokens.refreshToken);
      await _applyToken(result.tokens.token);
      return true;
    }
  } catch (e) {
    console.error("[Auth] Token refresh failed:", e);
    // Clear invalid tokens
    localStorage.removeItem(JWT_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }
  return false;
}

// ── Initialize ──
async function initAuth() {
  // 1. Check for OAuth callback code in URL
  const wasCallback = await handleAuthCallback();
  if (wasCallback) return;

  // 2. Try to restore from stored JWT
  if (await restoreSession()) return;

  // 3. No session
}

// ── Export ──
window.sbConvex = {
  client,
  api,
  signIn,
  signOut,
  initAuth,
  refreshSession,
  CONVEX_URL,
  CONVEX_SITE_URL,
};
