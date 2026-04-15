// ══════════════════════════════════════════
// Convex Client Initialization (Vanilla JS)
// ══════════════════════════════════════════

const CONVEX_URL = "https://different-viper-119.convex.cloud";
const CONVEX_SITE_URL = "https://different-viper-119.convex.site";

// The ConvexClient is loaded via CDN script tag (convex browser bundle)
// Access via global `convex` namespace
const ConvexClient = window.convex.ConvexClient;

const client = new ConvexClient(CONVEX_URL);

// Use anyApi since we don't have generated API in vanilla JS
const api = window.convex.anyApi;

// Auth token management
let _authToken = localStorage.getItem("sb_auth_token");
if (_authToken) {
  client.setAuth(
    () => _authToken,
    (isAuthenticated) => {
      window.dispatchEvent(
        new CustomEvent("convex-auth-change", { detail: { isAuthenticated } })
      );
    }
  );
}

function setAuthToken(token) {
  _authToken = token;
  localStorage.setItem("sb_auth_token", token);
  client.setAuth(
    () => token,
    (isAuthenticated) => {
      window.dispatchEvent(
        new CustomEvent("convex-auth-change", { detail: { isAuthenticated } })
      );
    }
  );
}

function clearAuthToken() {
  _authToken = null;
  localStorage.removeItem("sb_auth_token");
  // Reset client auth
  client.setAuth(
    () => null,
    () => {}
  );
}

// GitHub OAuth helpers
function startGitHubLogin() {
  // Redirect to Convex auth endpoint for GitHub OAuth
  const redirectUrl = `${CONVEX_SITE_URL}/api/auth/signin/github?site=${encodeURIComponent(window.location.origin)}`;
  window.location.href = redirectUrl;
}

// Handle OAuth callback - check for token in URL
function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    setAuthToken(token);
    // Clean up URL
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  }
}

// Export globally
window.sbConvex = {
  client,
  api,
  setAuthToken,
  clearAuthToken,
  startGitHubLogin,
  handleAuthCallback,
  CONVEX_URL,
  CONVEX_SITE_URL,
};
