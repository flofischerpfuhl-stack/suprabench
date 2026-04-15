// ══════════════════════════════════════════
// Convex Client + Auth (Vanilla JS)
// Ported from @convex-dev/auth React client
// ══════════════════════════════════════════

const CONVEX_URL = "https://different-viper-119.convex.cloud";
const CONVEX_SITE_URL = "https://different-viper-119.convex.site";

// Storage keys (must match @convex-dev/auth convention)
const NAMESPACE = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");
const VERIFIER_KEY = `__convexAuthOAuthVerifier_${NAMESPACE}`;
const JWT_KEY = `__convexAuthJWT_${NAMESPACE}`;
const REFRESH_KEY = `__convexAuthRefreshToken_${NAMESPACE}`;

// ── Initialize Convex Client ──
const ConvexClient = window.convex.ConvexClient;
const client = new ConvexClient(CONVEX_URL);
const api = window.convex.anyApi;

// ── Token State ──
let _currentToken = null;

function _applyToken(token) {
  _currentToken = token;
  if (token) {
    client.setAuth(
      () => token,
      (isAuthenticated) => {
        window.dispatchEvent(
          new CustomEvent("sb-auth-change", { detail: { isAuthenticated } })
        );
      }
    );
  }
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
    // OAuth flow: store verifier, redirect to provider
    localStorage.setItem(VERIFIER_KEY, result.verifier);
    window.location.href = result.redirect;
    return { signingIn: false, redirect: result.redirect };
  }

  if (result.tokens) {
    // Got tokens — store and apply
    localStorage.setItem(JWT_KEY, result.tokens.token);
    localStorage.setItem(REFRESH_KEY, result.tokens.refreshToken);
    _applyToken(result.tokens.token);
    window.dispatchEvent(new CustomEvent("sb-auth-change", { detail: { isAuthenticated: true } }));
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
  window.dispatchEvent(new CustomEvent("sb-auth-change", { detail: { isAuthenticated: false } }));
}

// ── Handle OAuth Callback ──
// Called on page load: checks for ?code= in the URL
async function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");

  if (code) {
    // Clean URL immediately
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);

    // Exchange code + stored verifier for tokens
    try {
      await signIn(undefined, { code });
    } catch (e) {
      console.error("[Auth] Code exchange failed:", e);
    }
    return true;
  }
  return false;
}

// ── Restore Session from Storage ──
function restoreSession() {
  const storedToken = localStorage.getItem(JWT_KEY);
  if (storedToken) {
    _applyToken(storedToken);
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
      _applyToken(result.tokens.token);
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
  if (restoreSession()) return;

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
