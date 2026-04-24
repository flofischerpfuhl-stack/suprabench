// ══════════════════════════════════════════
// SupraBench Alpine.js Application
// ══════════════════════════════════════════

const OFFICIAL_DOMAINS = [
  "arxiv.org", "openreview.net", "aclanthology.org",
  "neurips.cc", "iclr.cc", "icml.cc", "proceedings.mlr.press",
  "paperswithcode.com", "huggingface.co",
  "artificialanalysis.ai", "livebench.ai", "lmarena.ai",
  "chat.lmsys.org", "lmsys.org", "openllm-leaderboard.com",
  "swebench.com", "aider.chat", "evalplus.github.io",
  "bigcode-bench.github.io", "bigcode-project.github.io",
  "tau-bench.github.io", "math-eval.github.io",
  "arcprize.org", "mlperf.org", "mlcommons.org",
  "scale.com", "opencompass.org", "crfm.stanford.edu",
  "nlp.stanford.edu", "github.io",
  "openai.com", "anthropic.com", "deepmind.google", "deepmind.com",
  "blog.google", "ai.google.dev", "ai.meta.com", "about.fb.com",
  "mistral.ai", "x.ai", "cohere.com", "databricks.com",
  "nvidia.com", "developer.nvidia.com", "blogs.nvidia.com",
  "research.microsoft.com", "microsoft.com",
  "qwenlm.github.io", "deepseek.com",
];

function checkOfficialUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
  } catch { return false; }
}

// Display-only mirror of the max-keys-per-tier config in
// convex/tiers.ts. Server-side enforcement lives in the `createKey`
// mutation; this just powers the "(2 / 3)" UI counter and disables
// the "Create key" button once the cap is hit, so the user gets
// a clear UI hint instead of a thrown error.
//
// Drift is caught by npm run check:tiers (see
// scripts/check-tier-consistency.mjs) via the max-keys column in
// public/docs/api/authentication.html; if you change these, adjust
// that doc in the same commit.
const TIER_MAX_KEYS = {
  starter: 1,
  pro: 3,
  enterprise: 10,
  enterprise_plus: 50,
  // Partner keys default to 1 each; the CLI mutation can override
  // per key. This is only a fallback for the profile UI cap check
  // and deliberately matches PARTNER_DEFAULTS.maxKeys in convex/
  // tiers.ts — if you bump one, bump the other and the lint script
  // will catch the drift.
  partner: 1,
};

// Used by tier-card buttons to decide which tier is "up" vs "down"
// when an already-subscribed user clicks another tier. Stripe itself
// doesn't know this ordering — we do. Partner is intentionally NOT
// in this list: it's a separate category (invite-only, no self-serve),
// so clicking other tier cards while on partner shouldn't read as an
// "upgrade" or "downgrade" — tierButtonLabel falls through to
// "Subscribe" and tierAction short-circuits into the mailto path via
// the card's own <a href="mailto:…"> anchor.
const TIER_ORDER = ["starter", "pro", "enterprise", "enterprise_plus"];

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoToTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00Z");
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

let _entryCounter = 0;

function makeEmptyBench() {
  return {
    name: "", description: "", url: "",
    scaleMin: 0, scaleMax: 100,
    tags: [], tagInput: "", lastFlashIdx: -1,
    // UI-only flag: whether the tag-suggestion dropdown is open.
    // We need explicit state because we suppress the dropdown after a
    // chip is added so the user sees the chip land instead of an
    // immediate re-suggestion.
    tagSuggestOpen: false,
  };
}
function makeEmptyModel() {
  return {
    name: "", provider: "", familyTag: "",
    tags: [], tagInput: "", lastFlashIdx: -1,
    // UI-only autocomplete-dropdown state. The native HTML5 <datalist>
    // we previously relied on is unreliable on mobile (Android Chrome's
    // suggest bar covers it, iOS shows it as a tiny scroller above the
    // keyboard) so we render our own dropdown and gate visibility with
    // these per-field flags.
    providerOpen: false,
    familyOpen: false,
    tagSuggestOpen: false,
  };
}

// One entry inside the "for-bench" form (= one model on this bench)
function makeBenchScoreEntry() {
  _entryCounter += 1;
  return {
    _id: _entryCounter,
    collapsed: false,
    modelSearch: "",
    modelResults: [],
    selectedModel: null,
    isNewModel: false,
    newModel: makeEmptyModel(),
    rawScore: "",
    normalizedPreview: null,
    sourceUrl: "",
    accessedAt: todayIsoDate(),
  };
}

// One entry inside the "for-model" form (= one bench scored for this model).
// Restricted to existing benches — to publish a new bench, use the "Bench" tab.
function makeModelScoreEntry() {
  _entryCounter += 1;
  return {
    _id: _entryCounter,
    collapsed: false,
    benchSearch: "",
    benchResults: [],
    selectedBench: null,
    rawScore: "",
    normalizedPreview: null,
    sourceUrl: "",
    accessedAt: todayIsoDate(),
  };
}

function makeFormA() {
  return {
    modelSearch: "", modelResults: [], selectedModel: null,
    benchSearch: "", benchResults: [], selectedBench: null,
    rawScore: "", normalizedPreview: null,
    sourceUrl: "", accessedAt: todayIsoDate(),
  };
}

function makeFormB() {
  return {
    benchSearch: "", benchResults: [], selectedBench: null,
    isNewBench: true,
    newBench: makeEmptyBench(),
    isOfficialDetected: false,
    scoreEntries: [makeBenchScoreEntry()],
  };
}

function makeFormC() {
  return {
    modelSearch: "", modelResults: [], selectedModel: null,
    isNewModel: true,
    newModel: makeEmptyModel(),
    scoreEntries: [makeModelScoreEntry()],
  };
}

// ── PWA: service worker + install prompt ────────────────────
//
// Registered after `load` so it never competes with critical
// rendering. Skipped on `localhost` to avoid stale-cache headaches
// during local development.
//
// The `beforeinstallprompt` event lets us defer the browser's
// "Install app?" UI and trigger it from a button later, instead of
// the browser deciding when to ambush the user. We stash it on
// window.sbPwa.deferredPrompt — the Alpine root reads that to show
// or hide an "Install" CTA.
window.sbPwa = {
  deferredPrompt: null,
  isInstalled: false,
  swRegistration: null,
  async install() {
    if (!this.deferredPrompt) return false;
    this.deferredPrompt.prompt();
    const choice = await this.deferredPrompt.userChoice;
    this.deferredPrompt = null;
    window.dispatchEvent(new CustomEvent("sb-pwa-state"));
    return choice.outcome === "accepted";
  },
};

(function bootPwa() {
  if (typeof window === "undefined") return;

  // Detect "running as installed PWA" to suppress the install CTA.
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    window.navigator.standalone === true; // iOS
  window.sbPwa.isInstalled = standalone;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.sbPwa.deferredPrompt = e;
    window.dispatchEvent(new CustomEvent("sb-pwa-state"));
  });

  window.addEventListener("appinstalled", () => {
    window.sbPwa.isInstalled = true;
    window.sbPwa.deferredPrompt = null;
    window.dispatchEvent(new CustomEvent("sb-pwa-state"));
  });

  if (!("serviceWorker" in navigator)) return;
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (isLocal) return; // no SW in dev — easier to debug

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      window.sbPwa.swRegistration = reg;

      // If a new SW is waiting, prompt it to take over on next nav.
      // We don't auto-reload — that would yank the page out from under
      // the user mid-action. The user gets a fresh build on their next
      // navigation / hash change.
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) {
            w.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    } catch (e) {
      console.warn("[PWA] service worker registration failed:", e);
    }
  });
})();

// ── Giscus integration ──────────────────────────────────────
//
// Mounts the giscus iframe in `container` for the discussion identified
// by `term`. Re-mounts cleanly when the term changes (used to switch
// between bench / submission detail pages without leaking the previous
// thread).
//
// We tear down + re-inject the script tag rather than using giscus's
// postMessage `setConfig` API, because the latter only works after the
// iframe has finished loading — racy on the first navigation.
//
// Theme: a custom CSS file served from this origin
// (/css/giscus-theme.css) that mirrors the SupraBench dark palette.
// We resolve it to an absolute https:// URL so giscus's iframe can load
// it cross-origin. On localhost we fall back to giscus's bundled
// `noborder_dark`, since the iframe can't fetch http://localhost:*.
window.sbGiscus = {
  cfg: {
    repo: "f14703416-sketch/suprabench-comments",
    repoId: "R_kgDOSGYwBg",
    category: "Comments",
    categoryId: "DIC_kwDOSGYwBs4C7KjZ",
  },
  _resolveTheme() {
    const o = window.location.origin;
    if (o.startsWith("https://")) return o + "/css/giscus-theme.css";
    return "noborder_dark";
  },
  mount(container, term) {
    if (!container || !term) return;
    if (container.dataset.giscusTerm === term) return;
    container.innerHTML = "";
    container.dataset.giscusTerm = term;
    const s = document.createElement("script");
    s.src = "https://giscus.app/client.js";
    const attrs = {
      "data-repo": this.cfg.repo,
      "data-repo-id": this.cfg.repoId,
      "data-category": this.cfg.category,
      "data-category-id": this.cfg.categoryId,
      "data-mapping": "specific",
      "data-term": term,
      "data-strict": "0",
      "data-reactions-enabled": "1",
      "data-emit-metadata": "0",
      "data-input-position": "bottom",
      "data-theme": this._resolveTheme(),
      "data-lang": "en",
      "data-loading": "lazy",
    };
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.crossOrigin = "anonymous";
    s.async = true;
    container.appendChild(s);
  },
};

function supraBench() {
  return {
    // ── View State ──
    view: "models",
    currentModelSlug: null,
    currentBenchSlug: null,
    currentSubmissionId: null,
    previousView: null,
    mobileMenuOpen: false,

    // ── Data (reactive from Convex) ──
    rankedModels: [],
    rankedBenches: [],
    allTags: [],
    allProviders: [],
    allFamilyTags: [],
    activeTags: [],
    // Active family-tag filter (string or "" / null). When set, the
    // models table filters to that family client-side via
    // filteredRankedModels. Separate from activeTags so it doesn't
    // clutter the tag-pill bar: a family is conceptually a "which
    // lineage of this lab's models" pick, not a capability filter.
    activeFamilyFilter: "",
    tagSearch: "",
    modelListSearch: "",
    benchListSearch: "",
    currentModel: null,
    currentBench: null,
    currentSubmission: null,
    currentBenchTagVotes: [],
    currentModelTagVotes: [],
    currentBenchEntityVote: null,
    currentModelEntityVote: null,
    profileData: null,
    profileSubmissionLimit: 25,

    // Profile sub-tab. Defaults to "activity" so existing users see the
    // page they always saw. The "api" tab hosts the public-API dashboard
    // (waitlist live, sub/keys disabled until api.future.ts ships).
    profileTab: "activity",
    waitlistEntries: [],   // { tier: string }[] — populated by waitlist.myEntries
    apiBusy: false,        // blocks double-clicks during waitlist toggle

    // Master switch for the paid API. false = waitlist-only mode
    // (current state of the world): all subscribe / manage-billing /
    // create-key / revoke-key methods short-circuit to a toast, the
    // tier-cards render "Join waitlist" buttons, no Stripe calls are
    // made, and _loadProfile skips the subscription/key queries so
    // it never hits non-existent backend functions.
    //
    // When the backend ships (see ACTIVATION.md): set this to true,
    // uncomment the subscription panel in public/index.html, and
    // uncomment the stripe/api modules in convex/. Every frontend
    // hook is already written; activation is a one-liner here plus
    // mechanical uncommenting elsewhere. No new JS gets authored.
    apiLive: false,

    // Populated by _loadProfile when apiLive is true. Schema matches
    // the commented-out api.api.myKeys + stripe.mySubscription queries.
    mySubscription: null,
    myApiKeys: [],
    // Usage roll-up across all of the caller's keys: { thisMonth,
    // monthlyQuota, byMonth: [{ yyyymm, calls }] }. Populated for
    // any user who currently holds an elevated tier (partner /
    // enterprise+) — those tiers are LIVE pre-launch.
    myUsageSummary: null,
    // Display-only — derived from mySubscription.tier via TIER_MAX_KEYS.
    // Default 3 (Pro) so the UI text makes sense on first paint for
    // users without a sub (they see "0 / 3" which reads fine).
    apiKeyLimit: 3,
    newKeyJustCreated: null,
    // Self-serve mint form (partner / enterprise+ users only).
    // Submitted by `mintMyKey()` to api:createMyKey.
    myKeyName: "",
    // Toggle for the "Browse other plans" section that appears when
    // the user already has a granted tier — keeps the dashboard
    // up top as the focus, plans grid one click away.
    plansExpanded: false,

    // About-page Q&A: a Set of question-IDs that are currently expanded.
    // Default: first question open so the page isn't a wall of buttons.
    aboutOpen: new Set(["q1"]),

    // ── Admin Board ──
    // Visible only when `user.isAdmin` is true. The primary admin
    // (user.isPrimaryAdmin) additionally sees the admin-promote/demote
    // controls — delegated admins can only grant tiers, not admins.
    adminQuery: "",
    adminResults: [],
    adminSelected: null,      // full user-detail object from getUserDetail.
                              // Doubles as the "expanded row" indicator —
                              // a row is expanded iff adminSelected._id
                              // matches it (see adminToggleSelect).
    adminBusy: false,
    adminFlash: null,         // toast-lite: { kind: 'ok'|'err', msg: string }
    adminNewKey: null,        // plaintext once after mintKeyForUser
    adminKeyName: "",
    adminGrantForm: {
      tier: "partner",
      monthlyQuota: 100000,
      rpmLimit: 60,
      maxKeys: 3,
      allowExport: true,
    },

    // ── Auth ──
    user: null,

    // ── Submit Forms (3 modes) ──
    submitMode: "score",
    submitFormA: makeFormA(),
    submitFormB: makeFormB(),
    submitFormC: makeFormC(),
    submitting: false,
    submitError: null,
    submitSuccess: null,

    // ── Bench Detail ──
    myRating: null,
    ratingForm: { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0, difficulty: 0 },
    showRatingForm: false,
    showTagSuggest: false,
    tagSuggestInput: "",

    // Bench-detail tab: "scores" | "discussion" | "submissions" | "tags".
    // The bench detail page used to render every section unconditionally
    // which pushed the actual ranking far below the fold (description +
    // 5 quality dimensions + bench-score breakdown + entire model-scores
    // table + every submission stacked underneath). We pulled the
    // model-scores table, the all-submissions list, the discussion iframe
    // and the tag-vote block into a single tab strip so the user sees
    // metadata first, then picks what they want. "scores" is the default
    // because that's what people came for — the ranking on this bench.
    // Giscus is mounted lazily — only when its tab is active — which
    // also fixes the "empty container" race we hit when the iframe was
    // placed below a long, hidden list.
    benchDetailTab: "scores",

    // Model-detail tab: "submissions" | "tags". Same idea — the tag-vote
    // block was sitting between entity-vote and the SupraScore which
    // ate space above the actual ranking data. Pushed below into a tab
    // strip alongside the per-bench submission list.
    modelDetailTab: "submissions",

    // Bench description on the detail page is collapsed by default —
    // the description + source link can run 4-5 lines on benches like
    // SWE-bench Verified, which pushes the entity-vote / quality bars
    // off the first viewport on a phone.
    benchDescExpanded: false,

    // Bench Score breakdown collapsed by default — the headline number
    // and the "?" tooltip on the breakdown header are usually enough;
    // power users can expand for the live Q/D/H/√(u/U*)/√(N/N*) split.
    benchBreakdownExpanded: false,

    // ── Sort ──
    benchSortField: "score",
    benchSortAsc: false,

    // ── Mobile expand state for list rows ──
    expandedListRows: {}, // { [id]: true }

    // ── Subscriptions ──
    // Long-lived subscriptions that stay open for the whole session
    // (one per query). Anything not listed here is loaded on-demand
    // via _ensureViewSubscriptions when the user actually navigates to
    // a view that needs it. This dramatically reduces idle bandwidth
    // and Convex function calls — important on the free tier.
    _unsubscribers: [],
    _activeSubs: {}, // { name: unsubFn } for view-scoped subs

    // ═══ INIT ═══
    async init() {
      const { client, api, initAuth } = window.sbConvex;

      await initAuth();

      this._parseHash();
      window.addEventListener("hashchange", () => {
        this._parseHash();
        this._ensureViewSubscriptions();
      });

      window.addEventListener("sb-auth-change", async (e) => {
        if (e.detail?.isAuthenticated) {
          try {
            const u = await client.query(api.users.viewer, {});
            if (u) this.user = u;
          } catch (err) {
            console.error("[auth] viewer fetch after auth-change failed:", err);
          }
        } else {
          this.user = null;
        }
      });

      // Auth identity: small, needed everywhere, keep as global subscription.
      this._subscribe(api.users.viewer, {}, (data) => {
        this.user = data;
        // refetch profile if currently shown
        if (this.view === "profile") this._loadProfile();
      });

      try {
        if (localStorage.getItem(`__convexAuthJWT_${window.sbConvex.CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "")}`)) {
          const u = await client.query(api.users.viewer, {});
          if (u) this.user = u;
        }
      } catch (e) { /* ignore */ }

      // Open the right view-scoped subscriptions for the initial route.
      this._ensureViewSubscriptions();

      // Stripe-Checkout return handler. When the user completes (or
      // cancels) Checkout, Stripe redirects to
      //   /#api?stripe=success&session_id=...
      //   /#api?stripe=cancel
      // (success_url / cancel_url are set in stripe.future.ts).
      // We toast appropriately, refresh the profile twice (once now,
      // once in 3s — the webhook that mirrors the sub into Convex may
      // lag the redirect by a second or two), and strip the query
      // string so a page-reload doesn't re-fire the toast.
      //
      // Runs unconditionally (not gated on apiLive) because the URL
      // params can only exist if someone actually went through Stripe
      // Checkout, which requires the backend to be live — if we're
      // pre-launch, this block is just a no-op.
      this._handleStripeReturn();
    },

    _handleStripeReturn() {
      const params = new URLSearchParams(location.search);
      const stripeStatus = params.get("stripe");
      if (!stripeStatus) return;
      if (stripeStatus === "success") {
        this.showToast(
          "Subscription activated — create your first API key below.",
          "info",
        );
        // Make sure the user lands on the API & Billing tab, not the
        // Activity tab — regardless of what the SPA default is. The
        // hash may or may not already be #profile depending on what
        // STRIPE_RETURN_URL is set to; force it explicitly.
        if (this.view !== "profile") this.navigate?.("profile");
        this.profileTab = "api";
        // The webhook that mirrors the sub into Convex may lag the
        // redirect by a second or two. Refresh twice: once now (fast
        // path), once after 3s (slow path).
        setTimeout(() => this._loadProfile(), 100);
        setTimeout(() => this._loadProfile(), 3000);
      } else if (stripeStatus === "cancel") {
        this.showToast("Checkout canceled — no charge was made.", "info");
        this.profileTab = "api";
      }
      history.replaceState({}, "", location.pathname + location.hash);
    },

    _subscribe(fnRef, args, callback) {
      const unsub = window.sbConvex.client.onUpdate(fnRef, args, callback);
      this._unsubscribers.push(unsub);
    },

    // Open a named view-scoped subscription. Subsequent calls with the
    // same name are no-ops (already subscribed).
    _viewSub(name, fnRef, args, callback) {
      if (this._activeSubs[name]) return;
      this._activeSubs[name] = window.sbConvex.client.onUpdate(fnRef, args, callback);
    },

    _closeViewSub(name) {
      const u = this._activeSubs[name];
      if (u) {
        try { u(); } catch (e) { /* ignore */ }
        delete this._activeSubs[name];
      }
    },

    // Open exactly the subscriptions / one-shot fetches the current view
    // needs. Older subscriptions for views the user has navigated away
    // from get torn down so their server-side query handlers stop firing
    // for this client.
    async _ensureViewSubscriptions() {
      const { client, api } = window.sbConvex;
      const v = this.view;

      // Models list view: needs ranked models + tag list (for the filter bar).
      const wantModels = v === "models";
      // Benches list view: needs ranked benches + tag list.
      const wantBenches = v === "benchmarks";
      // Tag list is needed on:
      //   - models / benchmarks list pages (filter bar)
      //   - modelDetail / benchDetail (datalist autocomplete for "suggest tag")
      //   - submit (datalist autocomplete on score forms)
      const wantTags = wantModels || wantBenches
        || v === "modelDetail" || v === "benchDetail" || v === "submit";
      // Submit view: needs providers + familyTags for autocomplete.
      const wantSubmitMeta = v === "submit";

      if (wantModels) {
        this._viewSub("models.listRanked", api.models.listRanked, {}, (data) => {
          this.rankedModels = data || [];
        });
      } else {
        this._closeViewSub("models.listRanked");
      }

      if (wantBenches) {
        this._viewSub("benches.listRanked", api.benches.listRanked, {}, (data) => {
          this.rankedBenches = data || [];
        });
      } else {
        this._closeViewSub("benches.listRanked");
      }

      if (wantTags) {
        this._viewSub("tags.listAll", api.tags.listAll, {}, (data) => {
          this.allTags = (data || []).map(t => t.tag);
        });
      } else {
        this._closeViewSub("tags.listAll");
      }

      // Submit-form metadata: one-shot fetch instead of subscription, since
      // these lists barely change and the form doesn't need live updates.
      if (wantSubmitMeta) {
        if (this.allProviders.length === 0) {
          try {
            this.allProviders = await client.query(api.models.listProviders, {}) || [];
          } catch (e) { console.error("listProviders failed:", e); }
        }
        if (this.allFamilyTags.length === 0) {
          try {
            this.allFamilyTags = await client.query(api.models.listFamilyTags, {}) || [];
          } catch (e) { console.error("listFamilyTags failed:", e); }
        }
      }
    },

    // ═══ ROUTING ═══
    _parseHash() {
      this.mobileMenuOpen = false;
      this.expandedListRows = {};
      const hash = window.location.hash.slice(1) || "models";
      const parts = hash.split("/");

      if (parts[0] === "models" || parts[0] === "") {
        this.view = "models";
      } else if (parts[0] === "model" && parts[1]) {
        this.view = "modelDetail";
        this.currentModelSlug = decodeURIComponent(parts[1]);
        this._loadModelDetail();
      } else if (parts[0] === "benches") {
        this.view = "benchmarks";
      } else if (parts[0] === "bench" && parts[1]) {
        this.view = "benchDetail";
        this.currentBenchSlug = decodeURIComponent(parts[1]);
        this._loadBenchDetail();
      } else if (parts[0] === "submit") {
        this.view = "submit";
        if (parts[1] === "bench") this.submitMode = "bench";
        else if (parts[1] === "model") this.submitMode = "model";
        else this.submitMode = "score";
      } else if (parts[0] === "submission" && parts[1]) {
        this.view = "submission";
        this.currentSubmissionId = parts[1];
        this._loadSubmissionDetail();
      } else if (parts[0] === "about") {
        this.view = "about";
        this.$nextTick && this.$nextTick(() => this.renderAboutMath());
      } else if (parts[0] === "profile") {
        this.view = "profile";
        // Support deep-linking to a specific profile tab: #profile/api,
        // #profile/admin. Default is "activity". Invalid tab names
        // collapse to "activity" so copy-pasted bad URLs don't 404.
        const allowedTabs = ["activity", "api", "admin"];
        if (parts[1] && allowedTabs.includes(parts[1])) {
          this.profileTab = parts[1];
        } else {
          this.profileTab = "activity";
        }
        this.adminNewKey = null;
        this.adminFlash = null;
        this._loadProfile();
      } else if (parts[0] === "admin") {
        // Legacy deep-link: #admin redirects to #profile/admin so the
        // admin board is reachable from bookmarks even after the move
        // from standalone view to profile tab.
        this.view = "profile";
        this.profileTab = "admin";
        this.adminNewKey = null;
        this.adminFlash = null;
        this._loadProfile();
      }
    },

    navigate(view, params) {
      this.previousView = this.view;
      let hash = view;
      if (params?.slug) hash += "/" + params.slug;
      if (params?.id) hash += "/" + params.id;
      if (params?.mode) hash += "/" + params.mode;
      window.location.hash = hash;
    },

    setSubmitMode(mode) {
      this.submitMode = mode;
      this.submitError = null;
      this.submitSuccess = null;
      window.location.hash = "submit/" + mode;
    },

    // ═══ DATA LOADING ═══
    async _loadModelDetail() {
      const { client, api } = window.sbConvex;
      try {
        this.modelDetailTab = "submissions";
        this.currentModel = await client.query(api.models.getBySlug, { slug: this.currentModelSlug });
        if (this.currentModel) {
          this.currentModelTagVotes = await client.query(api.tagVotes.listForEntity, {
            entityType: "model",
            entityId: this.currentModel._id,
          });
          this.currentModelEntityVote = await client.query(api.entityVotes.getForEntity, {
            entityType: "model",
            entityId: this.currentModel._id,
          });
        }
      } catch (e) {
        console.error("Failed to load model:", e);
      }
    },

    async _loadBenchDetail() {
      const { client, api } = window.sbConvex;
      try {
        this.benchDetailTab = "scores";
        this.benchDescExpanded = false;
        this.benchBreakdownExpanded = false;
        this.currentBench = await client.query(api.benches.getBySlug, { slug: this.currentBenchSlug });
        if (this.currentBench) {
          this.currentBenchTagVotes = await client.query(api.tagVotes.listForEntity, {
            entityType: "bench",
            entityId: this.currentBench._id,
          });
          this.currentBenchEntityVote = await client.query(api.entityVotes.getForEntity, {
            entityType: "bench",
            entityId: this.currentBench._id,
          });
          if (this.user) {
            this.myRating = await client.query(api.benchQualityRatings.getMyRating, { benchId: this.currentBench._id });
            if (this.myRating) {
              this.ratingForm = {
                relevance: this.myRating.relevance,
                contamination: this.myRating.contamination,
                discriminability: this.myRating.discriminability,
                reproducibility: this.myRating.reproducibility,
                difficulty: this.myRating.difficulty ?? 0,
              };
            }
          }
        }
      } catch (e) {
        console.error("Failed to load bench:", e);
      }
    },

    async _loadSubmissionDetail() {
      const { client, api } = window.sbConvex;
      try {
        this.currentSubmission = await client.query(api.submissions.getById, { id: this.currentSubmissionId });
      } catch (e) {
        console.error("Failed to load submission:", e);
      }
    },

    async _loadProfile() {
      if (!this.user) { this.profileData = null; this.waitlistEntries = []; return; }
      const { client, api } = window.sbConvex;
      try {
        this.profileData = await client.query(api.users.myActivity, {});
        this.profileSubmissionLimit = 25;
      } catch (e) {
        console.error("Failed to load profile:", e);
      }
      // Waitlist is independent: load it whenever the user lands on
      // their profile so the API tab is correct on first paint.
      try {
        this.waitlistEntries = await client.query(api.waitlist.myEntries, {});
      } catch (e) {
        console.warn("waitlist load failed (non-fatal):", e);
      }
      // Paid-API state: subscription + key list. Skipped entirely
      // pre-launch so we don't try to call backend functions that
      // don't exist yet (they'd throw "function not found"). Both
      // queries are cheap and only fire when the user actually
      // lands on their profile, not for anonymous pageviews.
      if (this.apiLive) {
        try {
          const [sub, keys] = await Promise.all([
            client.query(api.stripe.mySubscription, {}),
            client.query(api.api.myKeys, {}),
          ]);
          this.mySubscription = sub;
          this.myApiKeys = keys || [];
          // Sync display cap to the actually-subscribed tier so the
          // "(N / X)" counter shows the right denominator.
          if (sub?.tier && TIER_MAX_KEYS[sub.tier]) {
            this.apiKeyLimit = TIER_MAX_KEYS[sub.tier];
          }
        } catch (e) {
          console.warn("[api] subscription/keys load failed:", e);
        }
      } else if (this.user?.grantedTier) {
        // Partner / enterprise+ users get a real API dashboard even
        // pre-launch: their tier is LIVE (the /v1/ HTTP routes accept
        // those keys today; they self-serve mint via api:createMyKey
        // within the limits an admin granted). Pull keys + usage;
        // skip Stripe (no subscription rows for granted tiers).
        try {
          const [keys, usage] = await Promise.all([
            client.query(api.api.myKeys, {}),
            client.query(api.api.myUsageSummary, {}),
          ]);
          this.myApiKeys = keys || [];
          this.myUsageSummary = usage || null;
          if (this.user.grantedLimits?.maxKeys) {
            this.apiKeyLimit = this.user.grantedLimits.maxKeys;
          }
        } catch (e) {
          console.warn("[api] partner keys/usage load failed:", e);
        }
      }
      // Pre-load the elevated-accounts list for the admin tab so the
      // panel isn't empty on first open. Cheap: small table, only
      // fires for actual admins.
      if (this.user?.isAdmin) {
        try {
          this.adminResults = await client.query(api.admin.listElevatedAccounts, {});
          this.adminResultsAreElevated = true;
        } catch (e) {
          console.warn("[admin] elevated-accounts preload failed:", e);
        }
      }
    },

    // ── Admin Board ──────────────────────────────────────────────────
    // All mutations go through convex/admin.ts. The backend reasserts
    // every permission check; the frontend's `user.isAdmin` flag is
    // for display gating only.
    // True when the current adminResults set was loaded via
    // listElevatedAccounts (i.e. the search box is empty). Lets the
    // template show different empty-state copy for "no matches" vs
    // "no elevated accounts yet".
    adminResultsAreElevated: false,

    async adminSearch() {
      if (!this.user?.isAdmin) return;
      const q = (this.adminQuery || "").trim();
      const { client, api } = window.sbConvex;
      // Empty / too-short query: show the standing list of every
      // account that already has elevated privileges (admin /
      // partner / enterprise+). This is the default "who has
      // access?" view for the admin board.
      if (q.length < 2) {
        try {
          this.adminResults = await client.query(api.admin.listElevatedAccounts, {});
          this.adminResultsAreElevated = true;
        } catch (e) {
          console.error("[admin] listElevatedAccounts failed:", e);
          this._adminFlash("err", e.message || "Load failed");
        }
        return;
      }
      try {
        this.adminResults = await client.query(api.admin.searchUsers, { query: q });
        this.adminResultsAreElevated = false;
      } catch (e) {
        console.error("[admin] search failed:", e);
        this._adminFlash("err", e.message || "Search failed");
      }
    },
    /** Click handler for an admin-result row. Acts as an
     *  expand/collapse toggle: clicking the already-selected row
     *  collapses it (clears `adminSelected`), clicking a different
     *  row switches selection. The detail UI lives inside the row
     *  itself, so "selected" === "expanded". */
    async adminToggleSelect(userId) {
      if (!this.user?.isAdmin) return;
      if (this.adminSelected && this.adminSelected._id === userId) {
        this.adminSelected = null;
        this.adminNewKey = null;
        this.adminKeyName = "";
        return;
      }
      await this.adminSelect(userId);
    },
    async adminSelect(userId) {
      if (!this.user?.isAdmin) return;
      const { client, api } = window.sbConvex;
      try {
        this.adminSelected = await client.query(api.admin.getUserDetail, { userId });
        this.adminNewKey = null;
        this.adminKeyName = "";
        // Prime the grant form from the current grant so edits feel
        // like an update, not a wipe.
        if (this.adminSelected?.grantedLimits) {
          this.adminGrantForm = {
            tier: this.adminSelected.grantedTier || "partner",
            ...this.adminSelected.grantedLimits,
          };
        } else {
          this.adminGrantForm = {
            tier: "partner",
            monthlyQuota: 100000,
            rpmLimit: 60,
            maxKeys: 3,
            allowExport: true,
          };
        }
      } catch (e) {
        console.error("[admin] getUserDetail failed:", e);
        this._adminFlash("err", e.message || "Load failed");
      }
    },
    async adminRefreshSelected() {
      if (this.adminSelected?._id) await this.adminSelect(this.adminSelected._id);
      await this.adminSearch();
    },
    async adminGrantTier() {
      if (!this.user?.isAdmin || !this.adminSelected || this.adminBusy) return;
      const f = this.adminGrantForm;
      const limits = {
        monthlyQuota: Math.floor(Number(f.monthlyQuota) || 0),
        rpmLimit: Math.floor(Number(f.rpmLimit) || 0),
        maxKeys: Math.floor(Number(f.maxKeys) || 0),
        allowExport: !!f.allowExport,
      };
      if (limits.monthlyQuota < 1000 || limits.rpmLimit < 10 || limits.maxKeys < 1) {
        this._adminFlash("err", "Limits below minimum (quota ≥ 1000, rpm ≥ 10, keys ≥ 1)");
        return;
      }
      this.adminBusy = true;
      try {
        const { client, api } = window.sbConvex;
        await client.mutation(api.admin.grantTier, {
          userId: this.adminSelected._id,
          tier: f.tier,
          limits,
        });
        this._adminFlash("ok", `Granted ${f.tier} tier`);
        await this.adminRefreshSelected();
      } catch (e) {
        this._adminFlash("err", e.message || "Grant failed");
      } finally {
        this.adminBusy = false;
      }
    },
    async adminRevokeTier() {
      if (!this.user?.isAdmin || !this.adminSelected || this.adminBusy) return;
      const ok = await this.sbConfirm({
        title: "Revoke granted tier?",
        body: "This removes the user's Partner / Enterprise+ tier AND revokes every active API key tied to it. Their integrations will stop working immediately.",
        confirmLabel: "Revoke tier",
        danger: true,
      });
      if (!ok) return;
      this.adminBusy = true;
      try {
        const { client, api } = window.sbConvex;
        const res = await client.mutation(api.admin.revokeTier, {
          userId: this.adminSelected._id,
        });
        this._adminFlash("ok", `Tier revoked — ${res.revokedKeys} key(s) auto-revoked`);
        await this.adminRefreshSelected();
      } catch (e) {
        this._adminFlash("err", e.message || "Revoke failed");
      } finally {
        this.adminBusy = false;
      }
    },
    async adminGrantAdmin() {
      if (!this.user?.isPrimaryAdmin || !this.adminSelected || this.adminBusy) return;
      this.adminBusy = true;
      try {
        const { client, api } = window.sbConvex;
        await client.mutation(api.admin.grantAdmin, { userId: this.adminSelected._id });
        this._adminFlash("ok", "Admin role granted");
        await this.adminRefreshSelected();
      } catch (e) {
        this._adminFlash("err", e.message || "Grant admin failed");
      } finally {
        this.adminBusy = false;
      }
    },
    async adminRevokeAdmin() {
      if (!this.user?.isPrimaryAdmin || !this.adminSelected || this.adminBusy) return;
      const ok = await this.sbConfirm({
        title: "Revoke admin role?",
        body: "The user keeps their account but loses access to /admin and every admin-only mutation.",
        confirmLabel: "Revoke admin",
        danger: true,
      });
      if (!ok) return;
      this.adminBusy = true;
      try {
        const { client, api } = window.sbConvex;
        await client.mutation(api.admin.revokeAdmin, { userId: this.adminSelected._id });
        this._adminFlash("ok", "Admin role revoked");
        await this.adminRefreshSelected();
      } catch (e) {
        this._adminFlash("err", e.message || "Revoke admin failed");
      } finally {
        this.adminBusy = false;
      }
    },
    async adminMintKey() {
      if (!this.user?.isAdmin || !this.adminSelected || this.adminBusy) return;
      const name = (this.adminKeyName || "").trim();
      if (!name) { this._adminFlash("err", "Key name required"); return; }
      this.adminBusy = true;
      try {
        const { client, api } = window.sbConvex;
        const res = await client.mutation(api.admin.mintKeyForUser, {
          userId: this.adminSelected._id,
          name,
        });
        this.adminNewKey = res;   // shown once, plaintext field is rendered highlighted
        this.adminKeyName = "";
        this._adminFlash("ok", "Key minted — copy plaintext now");
        await this.adminRefreshSelected();
      } catch (e) {
        this._adminFlash("err", e.message || "Mint failed");
      } finally {
        this.adminBusy = false;
      }
    },
    async adminRevokeKey(keyId) {
      if (!this.user?.isAdmin || this.adminBusy) return;
      const ok = await this.sbConfirm({
        title: "Revoke this API key?",
        body: "The owner's app will stop working the moment we revoke. This action cannot be undone — they'll need a new key.",
        confirmLabel: "Revoke key",
        danger: true,
      });
      if (!ok) return;
      this.adminBusy = true;
      try {
        const { client, api } = window.sbConvex;
        await client.mutation(api.admin.revokeKey, { apiKeyId: keyId });
        this._adminFlash("ok", "Key revoked");
        await this.adminRefreshSelected();
      } catch (e) {
        this._adminFlash("err", e.message || "Revoke failed");
      } finally {
        this.adminBusy = false;
      }
    },
    async adminCopyKey() {
      if (!this.adminNewKey?.plaintext) return;
      try {
        await navigator.clipboard.writeText(this.adminNewKey.plaintext);
        this._adminFlash("ok", "Copied to clipboard");
      } catch {
        this._adminFlash("err", "Copy failed — select manually");
      }
    },
    adminDismissNewKey() {
      this.adminNewKey = null;
    },
    _adminFlash(kind, msg) {
      this.adminFlash = { kind, msg };
      setTimeout(() => {
        if (this.adminFlash && this.adminFlash.msg === msg) this.adminFlash = null;
      }, 4000);
    },
    adminFormatMonth(yyyymm) {
      if (!yyyymm) return "";
      const [y, m] = yyyymm.split("-");
      const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${names[parseInt(m, 10) - 1]} ${y}`;
    },

    // ── API & Billing tab ────────────────────────────────────────────
    isOnWaitlist(tier) {
      return Array.isArray(this.waitlistEntries) &&
             this.waitlistEntries.some((w) => w.tier === tier);
    },
    async toggleWaitlist(tier) {
      if (!this.user) {
        this.showToast("Sign in first to join the waitlist.", "info");
        this.login();
        return;
      }
      if (this.apiBusy) return;
      this.apiBusy = true;
      const { client, api } = window.sbConvex;
      try {
        if (this.isOnWaitlist(tier)) {
          await client.mutation(api.waitlist.leave, { tier });
          this.showToast(`Removed from ${tier} waitlist.`, "info");
        } else {
          await client.mutation(api.waitlist.join, { tier });
          this.showToast(`You're on the ${tier} waitlist — we'll email you at launch.`, "info");
        }
        this.waitlistEntries = await client.query(api.waitlist.myEntries, {});
      } catch (e) {
        console.error("waitlist toggle failed:", e);
        this.showToast(e?.message || "Something went wrong.", "error");
      } finally {
        this.apiBusy = false;
      }
    },

    // ── Custom dialog (replaces window.confirm + window.prompt) ──
    //
    // Both methods return a Promise that resolves when the user
    // confirms or cancels. One <div class="sb-dialog"> in the
    // template renders both kinds; the `kind` field switches
    // between confirm-only and prompt-with-text-input.
    //
    //   if (!await this.sbConfirm({ title: "Revoke key?", body: "…" })) return;
    //   const name = await this.sbPrompt({ title: "Name this key" });
    //
    // The native confirm/prompt blocks the JS thread; this one is
    // async, but the call sites are already async (they await
    // Convex mutations next), so the change is mechanical.
    sbDialog: {
      open: false,
      kind: "confirm",
      title: "",
      body: "",
      placeholder: "",
      value: "",
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
      danger: false,
      _resolve: null,
    },
    sbConfirm({ title, body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
      return new Promise((resolve) => {
        this.sbDialog = {
          open: true, kind: "confirm",
          title, body, value: "", placeholder: "",
          confirmLabel, cancelLabel, danger,
          _resolve: resolve,
        };
      });
    },
    sbPrompt({ title, body = "", placeholder = "", confirmLabel = "OK", cancelLabel = "Cancel" } = {}) {
      return new Promise((resolve) => {
        this.sbDialog = {
          open: true, kind: "prompt",
          title, body, value: "", placeholder,
          confirmLabel, cancelLabel, danger: false,
          _resolve: resolve,
        };
      });
    },
    sbDialogConfirm() {
      const dlg = this.sbDialog;
      if (!dlg.open) return;
      const out = dlg.kind === "prompt" ? (dlg.value || "").trim() : true;
      if (dlg.kind === "prompt" && !out) return; // require non-empty
      this.sbDialog = { ...dlg, open: false, _resolve: null };
      if (dlg._resolve) dlg._resolve(out);
    },
    sbDialogCancel() {
      const dlg = this.sbDialog;
      if (!dlg.open) return;
      const out = dlg.kind === "prompt" ? null : false;
      this.sbDialog = { ...dlg, open: false, _resolve: null };
      if (dlg._resolve) dlg._resolve(out);
    },

    // Lightweight toast — used by waitlist + future API actions.
    // Only one toast at a time; replacing the prior one is fine.
    showToast(message, type = "info") {
      this._toastTimer && clearTimeout(this._toastTimer);
      let el = document.getElementById("sb-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "sb-toast";
        document.body.appendChild(el);
      }
      el.className = `toast is-${type}`;
      el.textContent = message;
      this._toastTimer = setTimeout(() => { el.remove(); }, 4000);
    },

    // ── Paid-API actions ────────────────────────────────────────
    //
    // Every method below short-circuits when `apiLive` is false — that
    // flag gates the whole paid-API layer so this code can ship in the
    // public repo long before the backend is uncommented without the
    // risk of accidentally invoking a non-existent Convex function.
    //
    // Post-activation flow (when apiLive = true):
    //   subscribe(tier)         → Convex createCheckout → redirect to Stripe
    //   Stripe redirects back   → _handleStripeReturn in init() toasts + refetches
    //   manageBilling()         → Convex createBillingPortalSession → redirect
    //   openCreateKeyModal()    → sbPrompt(name) → Convex createKey → show plaintext once
    //   revokeApiKey(id)        → sbConfirm() → Convex revokeKey → refetch list
    //
    // Upgrade/downgrade is intentionally routed through the Stripe
    // Billing Portal rather than a new Checkout: Stripe handles the
    // proration, card reuse and VAT recalculation, and we get the new
    // tier via the customer.subscription.updated webhook, same
    // pipeline as an initial subscribe. One code path for every
    // subscription state change.

    async subscribe(tier) {
      if (!this.user) {
        this.showToast("Sign in first to subscribe.", "info");
        this.login();
        return;
      }
      if (!this.apiLive) {
        // Pre-launch users land here if they somehow hit a Subscribe
        // button that slipped through. Fall back to waitlist so the
        // button is never a dead end.
        return this.toggleWaitlist(tier);
      }
      if (tier === "enterprise_plus") {
        this.showToast("Enterprise+ is contract-based — contact us.", "info");
        return;
      }
      if (this.apiBusy) return;
      this.apiBusy = true;
      try {
        const { client, api } = window.sbConvex;
        const { url } = await client.mutation(api.stripe.createCheckout, { tier });
        window.location.href = url;
      } catch (e) {
        console.error("[stripe] checkout failed:", e);
        this.showToast(e?.message || "Could not start checkout.", "error");
        this.apiBusy = false;
      }
      // Note: we don't reset apiBusy on the success path — the browser
      // is about to navigate away from this tab entirely.
    },

    async manageBilling() {
      if (!this.apiLive) {
        this.showToast("API not yet live — join the waitlist!", "info");
        return;
      }
      if (!this.user) { this.login(); return; }
      if (this.apiBusy) return;
      this.apiBusy = true;
      try {
        const { client, api } = window.sbConvex;
        const { url } = await client.mutation(api.stripe.createBillingPortalSession, {});
        window.location.href = url;
      } catch (e) {
        console.error("[stripe] billing portal failed:", e);
        this.showToast(e?.message || "Could not open billing portal.", "error");
        this.apiBusy = false;
      }
    },

    async openCreateKeyModal() {
      if (!this.apiLive) {
        this.showToast("API not yet live — join the waitlist!", "info");
        return;
      }
      if (!this.user) { this.login(); return; }
      if (!this.mySubscription || this.mySubscription.status !== "active") {
        this.showToast("Subscribe to a tier first.", "info");
        return;
      }
      // Custom in-style prompt — see sbPrompt() for the dialog
      // contract. Cancel resolves to null, an empty/whitespace-only
      // name is rejected by the disabled-confirm-button rule, so by
      // the time we land here `name` is a non-empty trimmed string
      // (or null on cancel).
      const name = await this.sbPrompt({
        title: "Name this API key",
        body: "A short label so you can recognise it later in the dashboard.",
        placeholder: "e.g. My laptop, Production, CI/CD",
        confirmLabel: "Create key",
      });
      if (!name) return;
      if (this.apiBusy) return;
      this.apiBusy = true;
      try {
        const { client, api } = window.sbConvex;
        const { plaintext } = await client.mutation(api.api.createKey, {
          name,
          tier: this.mySubscription.tier,
        });
        // Show the plaintext in the inline modal; it's the only time
        // the user will ever see it. The HTML-side <template x-if>
        // renders the modal when newKeyJustCreated is truthy.
        this.newKeyJustCreated = plaintext;
        this.myApiKeys = await client.query(api.api.myKeys, {});
      } catch (e) {
        console.error("[api] createKey failed:", e);
        this.showToast(e?.message || "Could not create key.", "error");
      } finally {
        this.apiBusy = false;
      }
    },

    /** Self-serve mint for partner / enterprise+ users. The admin
     *  set the tier + per-user limits via grantTier; from there the
     *  user mints individual keys themselves so the plaintext is
     *  shown directly to the person who's going to use it (no
     *  insecure hand-off step). Reuses the same `newKeyJustCreated`
     *  state + Copy button as the paid-tier flow. */
    async mintMyKey() {
      if (!this.user?.grantedTier) {
        this.showToast("No granted tier — ask an admin to provision one first.", "info");
        return;
      }
      const name = (this.myKeyName || "").trim();
      if (!name) return;
      if (this.apiBusy) return;
      this.apiBusy = true;
      try {
        const { client, api } = window.sbConvex;
        const { plaintext } = await client.mutation(api.api.createMyKey, { name });
        this.newKeyJustCreated = plaintext;
        this.myKeyName = "";
        // Re-pull the key list so the new row appears below the
        // plaintext panel without a page refresh.
        this.myApiKeys = await client.query(api.api.myKeys, {});
      } catch (e) {
        console.error("[api] createMyKey failed:", e);
        this.showToast(e?.message || "Could not mint key.", "error");
      } finally {
        this.apiBusy = false;
      }
    },

    async revokeApiKey(apiKeyId) {
      // Partner / enterprise+ keys are minted by the user themselves
      // (api:createMyKey) but still revoked through the same
      // `api.revokeKey` mutation — backend gates on
      // `getAuthUserId()` ownership. Skip the apiLive gate when the
      // user already holds an elevated tier.
      if (!this.apiLive && !this.user?.grantedTier) {
        this.showToast("API not yet live — join the waitlist!", "info");
        return;
      }
      if (!apiKeyId) return;
      const ok = await this.sbConfirm({
        title: "Revoke this API key?",
        body: "Any app or script still using this key will stop working immediately. You can mint a fresh one right after.",
        confirmLabel: "Revoke key",
        danger: true,
      });
      if (!ok) return;
      if (this.apiBusy) return;
      this.apiBusy = true;
      try {
        const { client, api } = window.sbConvex;
        await client.mutation(api.api.revokeKey, { apiKeyId });
        this.myApiKeys = await client.query(api.api.myKeys, {});
        this.showToast("Key revoked.", "info");
      } catch (e) {
        console.error("[api] revokeKey failed:", e);
        this.showToast(e?.message || "Could not revoke key.", "error");
      } finally {
        this.apiBusy = false;
      }
    },

    async copyNewKey() {
      if (!this.newKeyJustCreated) return;
      try { await navigator.clipboard.writeText(this.newKeyJustCreated); this.showToast("Copied.", "info"); }
      catch { this.showToast("Copy failed — select & copy manually.", "error"); }
    },

    // ── Tier-card button dispatcher ─────────────────────────────
    //
    // Single click-handler for all four tier-card buttons. Branches
    // based on apiLive + current subscription so the tier-card HTML
    // stays identical across the pre-launch ("Join waitlist") and
    // post-launch ("Subscribe" / "Current plan" / "Change plan")
    // worlds. Enterprise+ stays waitlist-only forever — that tier
    // is contract-based and never hits self-serve checkout.

    async tierAction(tier) {
      // Partner is invite-only. The card renders a <a mailto:> anchor
      // instead of the usual button, so this branch is defence-in-depth:
      // if a future refactor ever wires the partner card's CTA to this
      // method, we want it to fail safe by opening the application
      // mailto instead of silently calling subscribe() or toggleWaitlist().
      if (tier === "partner") {
        window.location.href = "mailto:suprabench.editor887@passmail.com?subject=SupraBench%20Partner%20API%20application";
        return;
      }
      if (tier === "enterprise_plus") return this.toggleWaitlist(tier);
      if (!this.apiLive) return this.toggleWaitlist(tier);
      if (!this.user) { this.login(); return; }
      const cur = this.mySubscription;
      if (cur?.status === "active") {
        // User already has a sub; route ALL tier-card clicks
        // (same-tier or different-tier) through the billing portal —
        // that's where Stripe handles upgrade/downgrade/cancel with
        // proration in one place. Avoids us trying to reimplement
        // Stripe's plan-change UI.
        return this.manageBilling();
      }
      return this.subscribe(tier);
    },

    tierButtonLabel(tier) {
      // Enterprise+ + pre-launch: pure waitlist semantics.
      if (tier === "enterprise_plus" || !this.apiLive) {
        return this.isOnWaitlist(tier) ? "Leave waitlist" : "Join waitlist";
      }
      const cur = this.mySubscription;
      if (cur?.status === "active" && cur.tier === tier) {
        return cur.cancelAtPeriodEnd ? "Resume plan" : "Current plan";
      }
      if (cur?.status === "active") {
        // On another tier — show upgrade / downgrade based on
        // TIER_ORDER so the user understands direction before click.
        const curIdx = TIER_ORDER.indexOf(cur.tier);
        const thisIdx = TIER_ORDER.indexOf(tier);
        if (thisIdx > curIdx)  return "Upgrade";
        if (thisIdx < curIdx)  return "Downgrade";
      }
      return "Subscribe";
    },

    tierButtonDisabled(tier) {
      if (this.apiBusy) return true;
      if (!this.apiLive) return false;
      // Current-plan button is a no-op if no cancel pending. The click
      // would go through manageBilling so it's actually useful (lets
      // user cancel / update card), so keep it enabled.
      return false;
    },

    // NB: formatDate() exists lower down in this Alpine object and
    // handles the "cancels on DATE" rendering for the subscription
    // panel — don't re-declare here.

    get profileVisibleSubmissions() {
      if (!this.profileData) return [];
      return this.profileData.submissions.slice(0, this.profileSubmissionLimit);
    },
    get profileHasMoreSubmissions() {
      return this.profileData && this.profileData.submissions.length > this.profileSubmissionLimit;
    },
    showMoreSubmissions() {
      this.profileSubmissionLimit += 50;
    },
    showAllSubmissionsToggle() {
      this.profileSubmissionLimit = this.profileData?.submissions.length ?? 25;
    },

    // ── About-page Q&A controls ──
    aboutToggle(id) {
      if (this.aboutOpen.has(id)) this.aboutOpen.delete(id);
      else this.aboutOpen.add(id);
      // Trigger reactivity (Set mutations are not auto-tracked by Alpine).
      this.aboutOpen = new Set(this.aboutOpen);
      this.$nextTick(() => this.renderAboutMath());
    },
    aboutExpandAll() {
      const ids = ["q1","q2","q2b","q3","q4","q5","q6","q7","q8","q9","q10"];
      this.aboutOpen = new Set(ids);
      this.$nextTick(() => this.renderAboutMath());
    },
    aboutCollapseAll() {
      this.aboutOpen = new Set();
    },
    renderAboutMath() {
      // KaTeX auto-render is loaded via defer; wait for it if needed.
      const run = () => {
        if (typeof window.renderMathInElement !== "function") return;
        const root = document.querySelector("[x-show=\"view==='about'\"]");
        if (!root) return;
        window.renderMathInElement(root, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
          strict: "ignore",
        });
      };
      if (typeof window.renderMathInElement === "function") run();
      else setTimeout(run, 200);
    },

    // ═══ TAG FILTERING (model list) ═══
    toggleTag(tag) {
      const idx = this.activeTags.indexOf(tag);
      if (idx >= 0) this.activeTags.splice(idx, 1);
      else this.activeTags.push(tag);
      this._loadFilteredModels();
    },

    // ═══ FAMILY FILTERING (model list) ═══
    // Clicking a family-tag chip inside a model row: toggle it as the
    // sole active family filter. Clicking the same one again clears;
    // clicking a different one replaces the previous pick (a model
    // belongs to exactly one family, so multi-select would be odd).
    // This is pure client-side filtering over `rankedModels`, no
    // extra Convex query — scales fine up to a few thousand models.
    toggleFamilyFilter(family) {
      if (!family) return;
      this.activeFamilyFilter =
        this.activeFamilyFilter === family ? "" : family;
    },
    clearFamilyFilter() {
      this.activeFamilyFilter = "";
    },

    async _loadFilteredModels() {
      if (this.activeTags.length === 0) return;
      const { client, api } = window.sbConvex;
      try {
        this.rankedModels = await client.query(api.models.listRankedWithFilter, { activeTags: this.activeTags });
      } catch (e) {
        console.error("Failed to load filtered models:", e);
      }
    },

    get filteredAllTags() {
      const q = this.tagSearch.trim().toLowerCase();
      if (!q) return this.allTags;
      return this.allTags.filter(t => t.includes(q));
    },

    get visibleAllTags() {
      const all = this.filteredAllTags;
      if (this.tagSearch || all.length <= 20) return all;
      return all.slice(0, 20);
    },

    get hasMoreTags() {
      return !this.tagSearch && this.allTags.length > 20;
    },

    // ── Local autocomplete helpers for the submit form ──
    // The native HTML5 <datalist> we used to rely on is broken on mobile:
    // Android Chrome's keyboard-suggest bar covers the dropdown and iOS
    // surfaces it as a barely-visible scroller above the keyboard. So
    // every "free-text but ideally pick an existing one" field on the
    // submit form (provider, family tag, tags) now uses the same
    // styled dropdown pattern as the model-name search. These helpers
    // do client-side substring filtering against the in-memory dictionary
    // already loaded by _ensureViewSubscriptions() for the submit view.
    // Capped at 8 visible to keep the dropdown short on phones.
    filteredProviders(query) {
      const q = (query || "").trim().toLowerCase();
      if (!q) return this.allProviders.slice(0, 8);
      return this.allProviders
        .filter((p) => p.toLowerCase().includes(q))
        .slice(0, 8);
    },
    filteredFamilyTags(query) {
      const q = (query || "").trim().toLowerCase();
      if (!q) return this.allFamilyTags.slice(0, 8);
      return this.allFamilyTags
        .filter((f) => f.toLowerCase().includes(q))
        .slice(0, 8);
    },
    // For the tag-chip input: filter the master tag list by current
    // typed prefix and exclude tags already added as chips, so the
    // dropdown doesn't suggest something the user just selected.
    filteredTagSuggestions(query, alreadyAdded) {
      const q = (query || "").trim().toLowerCase();
      const added = new Set((alreadyAdded || []).map((t) => t.toLowerCase()));
      const base = this.allTags.filter((t) => !added.has(t.toLowerCase()));
      if (!q) return base.slice(0, 8);
      return base.filter((t) => t.toLowerCase().includes(q)).slice(0, 8);
    },

    get filteredRankedModels() {
      const q = this.modelListSearch.trim().toLowerCase();
      const famFilter = this.activeFamilyFilter;
      let list = this.rankedModels;
      if (famFilter) {
        list = list.filter((m) => m.familyTag === famFilter);
      }
      if (!q) return list;
      return list.filter((m) =>
        m.name.toLowerCase().includes(q) ||
        (m.provider || "").toLowerCase().includes(q) ||
        (m.tags || []).some((t) => t.includes(q))
      );
    },

    get filteredSortedBenches() {
      const q = this.benchListSearch.trim().toLowerCase();
      let list = this.sortedBenches;
      if (q) {
        list = list.filter(b =>
          b.name.toLowerCase().includes(q) ||
          (b.description || "").toLowerCase().includes(q) ||
          (b.tags || []).some(t => t.includes(q))
        );
      }
      return list;
    },

    toggleListRow(id) {
      this.expandedListRows[id] = !this.expandedListRows[id];
    },

    // ═══ AUTH ═══
    async login() {
      try { await window.sbConvex.signIn("google"); }
      catch (e) { console.error("Login failed:", e); }
    },

    async logout() {
      await window.sbConvex.signOut();
      this.user = null;
    },

    // ═══ TAG INPUT (shared) ═══
    // `obj` must be an object that owns both `.tags` (array) and
    // `.tagInput` (the bound text). `.lastFlashIdx` is optional (visual feedback).
    onTagInput(obj) {
      const v = obj.tagInput || "";
      const m = v.match(/^(.+?)\s*[,;]+\s*$/);
      if (m) this._commitTag(m[1], obj);
    },
    onTagKeydown(e, obj) {
      if (e.key === "Enter" || e.key === "," || e.key === ";") {
        e.preventDefault();
        const raw = (obj.tagInput || "").replace(/[,;]+\s*$/, "").trim();
        if (raw) this._commitTag(raw, obj);
        else obj.tagInput = "";
      }
    },
    onTagBlur(obj) {
      const raw = (obj.tagInput || "").trim();
      if (raw) this._commitTag(raw, obj);
    },
    _commitTag(raw, obj) {
      const t = raw.trim().toLowerCase().replace(/[,;]+$/g, "").trim();
      obj.tagInput = "";
      if (!t || t.length > 30) return;
      if (!Array.isArray(obj.tags)) obj.tags = [];
      if (obj.tags.includes(t)) return;
      obj.tags.push(t);
      const idx = obj.tags.length - 1;
      if ("lastFlashIdx" in obj) {
        obj.lastFlashIdx = idx;
        setTimeout(() => { if (obj.lastFlashIdx === idx) obj.lastFlashIdx = -1; }, 700);
      }
    },
    removeTag(obj, idx) { obj.tags.splice(idx, 1); },

    // Click handler for the tag-suggestion dropdown items.
    // We can't just call _commitTag with the chosen tag and leave it at
    // that, because the user has likely partially typed something into
    // tagInput — that partial text would otherwise sit in the input
    // after selection and look like an extra unfinished tag. So clear
    // the input first, commit the chosen suggestion, and close the
    // dropdown so it doesn't immediately re-open with the now-shorter
    // candidate set.
    addTagFromSuggestion(obj, tag) {
      obj.tagInput = "";
      this._commitTag(tag, obj);
      if ("tagSuggestOpen" in obj) obj.tagSuggestOpen = false;
    },

    // ═══ SUBMIT MODE A: SINGLE SCORE ═══
    async searchAModels() {
      const f = this.submitFormA;
      if (f.modelSearch.length < 2) { f.modelResults = []; return; }
      try { f.modelResults = await window.sbConvex.client.query(window.sbConvex.api.models.search, { query: f.modelSearch }); }
      catch { f.modelResults = []; }
    },
    selectAModel(m) {
      const f = this.submitFormA;
      f.selectedModel = m; f.modelSearch = m.name; f.modelResults = [];
    },
    async searchABenches() {
      const f = this.submitFormA;
      if (f.benchSearch.length < 2) { f.benchResults = []; return; }
      try { f.benchResults = await window.sbConvex.client.query(window.sbConvex.api.benches.search, { query: f.benchSearch }); }
      catch { f.benchResults = []; }
    },
    selectABench(b) {
      const f = this.submitFormA;
      f.selectedBench = b; f.benchSearch = b.name; f.benchResults = [];
    },
    updateANormalize() {
      const f = this.submitFormA;
      const raw = parseFloat(f.rawScore);
      if (isNaN(raw) || !f.selectedBench) { f.normalizedPreview = null; return; }
      const min = f.selectedBench.scaleMin, max = f.selectedBench.scaleMax;
      if (max === min) { f.normalizedPreview = 0; return; }
      f.normalizedPreview = Math.round(((raw - min) / (max - min)) * 10000) / 100;
    },
    async submitA() {
      if (!this.user) { this.submitError = "Please log in first."; return; }
      const f = this.submitFormA;
      this.submitting = true; this.submitError = null; this.submitSuccess = null;
      try {
        if (!f.selectedModel) throw new Error("Please pick an existing model.");
        if (!f.selectedBench) throw new Error("Please pick an existing benchmark.");
        const raw = parseFloat(f.rawScore);
        if (!Number.isFinite(raw)) throw new Error("Invalid score.");
        if (!f.sourceUrl?.trim()) throw new Error("Source URL required.");
        const ts = isoToTimestamp(f.accessedAt);
        if (!ts) throw new Error("Invalid 'accessed on' date.");
        const res = await window.sbConvex.client.mutation(
          window.sbConvex.api.submissions.submitOne,
          {
            modelId: f.selectedModel._id, benchId: f.selectedBench._id,
            rawScore: raw, sourceUrl: f.sourceUrl, accessedAt: ts,
          }
        );
        this.submitSuccess = res; this.submitFormA = makeFormA();
      } catch (e) {
        this.submitError = e.message || "Submission failed.";
      } finally { this.submitting = false; }
    },

    // ═══ SUBMIT MODE B: NEW BENCH + MANY SCORES ═══
    async searchBBenches() {
      const f = this.submitFormB;
      if (f.benchSearch.length < 2) { f.benchResults = []; return; }
      try { f.benchResults = await window.sbConvex.client.query(window.sbConvex.api.benches.search, { query: f.benchSearch }); }
      catch { f.benchResults = []; }
    },
    selectBBench(b) {
      const f = this.submitFormB;
      f.selectedBench = b; f.benchSearch = b.name; f.benchResults = []; f.isNewBench = false;
    },
    startNewBBench() {
      const f = this.submitFormB;
      f.isNewBench = true; f.selectedBench = null;
      f.newBench.name = f.benchSearch; f.benchResults = [];
    },
    checkBBenchUrl() {
      this.submitFormB.isOfficialDetected = checkOfficialUrl(this.submitFormB.newBench.url);
    },

    addBScoreEntry() {
      for (const e of this.submitFormB.scoreEntries) e.collapsed = true;
      this.submitFormB.scoreEntries.push(makeBenchScoreEntry());
    },
    removeBScoreEntry(entry) {
      const arr = this.submitFormB.scoreEntries;
      const idx = arr.indexOf(entry);
      if (idx >= 0 && arr.length > 1) arr.splice(idx, 1);
    },
    toggleBScoreEntry(entry) { entry.collapsed = !entry.collapsed; },
    async searchBModelsForEntry(entry) {
      if (entry.modelSearch.length < 2) { entry.modelResults = []; return; }
      try { entry.modelResults = await window.sbConvex.client.query(window.sbConvex.api.models.search, { query: entry.modelSearch }); }
      catch { entry.modelResults = []; }
    },
    selectBModelForEntry(entry, m) {
      entry.selectedModel = m; entry.modelSearch = m.name;
      entry.modelResults = []; entry.isNewModel = false;
    },
    startNewBModelForEntry(entry) {
      entry.isNewModel = true; entry.selectedModel = null;
      entry.newModel.name = entry.modelSearch; entry.modelResults = [];
    },
    bScaleMin() {
      const f = this.submitFormB;
      if (f.selectedBench) return f.selectedBench.scaleMin;
      if (f.isNewBench) return parseFloat(f.newBench.scaleMin) || 0;
      return 0;
    },
    bScaleMax() {
      const f = this.submitFormB;
      if (f.selectedBench) return f.selectedBench.scaleMax;
      if (f.isNewBench) return parseFloat(f.newBench.scaleMax) || 100;
      return 100;
    },
    updateBNormalize(entry) {
      const raw = parseFloat(entry.rawScore);
      if (isNaN(raw)) { entry.normalizedPreview = null; return; }
      const min = this.bScaleMin(), max = this.bScaleMax();
      if (max === min) { entry.normalizedPreview = 0; return; }
      entry.normalizedPreview = Math.round(((raw - min) / (max - min)) * 10000) / 100;
    },
    bEntryLabel(entry, idx) {
      if (entry.selectedModel) return entry.selectedModel.name;
      if (entry.isNewModel && entry.newModel.name) return entry.newModel.name + " (new)";
      return `Score #${idx + 1}`;
    },
    async submitB() {
      if (!this.user) { this.submitError = "Please log in first."; return; }
      const f = this.submitFormB;
      this.submitting = true; this.submitError = null; this.submitSuccess = null;
      try {
        const args = {};
        if (f.selectedBench) args.benchId = f.selectedBench._id;
        else if (f.isNewBench) {
          if (!f.newBench.name?.trim()) throw new Error("Benchmark name required.");
          if (!f.newBench.description?.trim()) throw new Error("Benchmark description required.");
          if (!f.newBench.url?.trim()) throw new Error("Benchmark URL required.");
          args.newBench = {
            name: f.newBench.name, description: f.newBench.description, url: f.newBench.url,
            scaleMin: parseFloat(f.newBench.scaleMin) || 0,
            scaleMax: parseFloat(f.newBench.scaleMax) || 100,
            tags: f.newBench.tags,
          };
        } else throw new Error("Please pick or create a benchmark.");

        const scores = [];
        for (let i = 0; i < f.scoreEntries.length; i++) {
          const entry = f.scoreEntries[i];
          const e = {};
          if (entry.selectedModel) e.modelId = entry.selectedModel._id;
          else if (entry.isNewModel) {
            if (!entry.newModel.name?.trim()) throw new Error(`Score #${i + 1}: model name required`);
            if (!entry.newModel.provider?.trim()) throw new Error(`Score #${i + 1}: provider required`);
            e.newModel = {
              name: entry.newModel.name, provider: entry.newModel.provider,
              familyTag: entry.newModel.familyTag || undefined, tags: entry.newModel.tags,
            };
          } else throw new Error(`Score #${i + 1}: pick or create a model`);
          const raw = parseFloat(entry.rawScore);
          if (!Number.isFinite(raw)) throw new Error(`Score #${i + 1}: invalid score`);
          e.rawScore = raw;
          if (!entry.sourceUrl?.trim()) throw new Error(`Score #${i + 1}: source URL required`);
          e.sourceUrl = entry.sourceUrl;
          const ts = isoToTimestamp(entry.accessedAt);
          if (!ts) throw new Error(`Score #${i + 1}: invalid 'accessed on' date`);
          e.accessedAt = ts;
          scores.push(e);
        }
        args.scores = scores;
        const res = await window.sbConvex.client.mutation(window.sbConvex.api.submissions.submitForBench, args);
        this.submitSuccess = res; this.submitFormB = makeFormB();
      } catch (e) {
        this.submitError = e.message || "Submission failed.";
      } finally { this.submitting = false; }
    },

    // ═══ SUBMIT MODE C: NEW MODEL + MANY BENCH SCORES ═══
    async searchCModels() {
      const f = this.submitFormC;
      if (f.modelSearch.length < 2) { f.modelResults = []; return; }
      try { f.modelResults = await window.sbConvex.client.query(window.sbConvex.api.models.search, { query: f.modelSearch }); }
      catch { f.modelResults = []; }
    },
    selectCModel(m) {
      const f = this.submitFormC;
      f.selectedModel = m; f.modelSearch = m.name; f.modelResults = []; f.isNewModel = false;
    },
    startNewCModel() {
      const f = this.submitFormC;
      f.isNewModel = true; f.selectedModel = null;
      f.newModel.name = f.modelSearch; f.modelResults = [];
    },
    addCScoreEntry() {
      for (const e of this.submitFormC.scoreEntries) e.collapsed = true;
      this.submitFormC.scoreEntries.push(makeModelScoreEntry());
    },
    removeCScoreEntry(entry) {
      const arr = this.submitFormC.scoreEntries;
      const idx = arr.indexOf(entry);
      if (idx >= 0 && arr.length > 1) arr.splice(idx, 1);
    },
    toggleCScoreEntry(entry) { entry.collapsed = !entry.collapsed; },
    async searchCBenchesForEntry(entry) {
      if (entry.benchSearch.length < 2) { entry.benchResults = []; return; }
      try { entry.benchResults = await window.sbConvex.client.query(window.sbConvex.api.benches.search, { query: entry.benchSearch }); }
      catch { entry.benchResults = []; }
    },
    selectCBenchForEntry(entry, b) {
      entry.selectedBench = b; entry.benchSearch = b.name; entry.benchResults = [];
    },
    cEntryScaleMin(entry) { return entry.selectedBench ? entry.selectedBench.scaleMin : 0; },
    cEntryScaleMax(entry) { return entry.selectedBench ? entry.selectedBench.scaleMax : 100; },
    updateCNormalize(entry) {
      const raw = parseFloat(entry.rawScore);
      if (isNaN(raw) || !entry.selectedBench) { entry.normalizedPreview = null; return; }
      const min = entry.selectedBench.scaleMin, max = entry.selectedBench.scaleMax;
      if (max === min) { entry.normalizedPreview = 0; return; }
      entry.normalizedPreview = Math.round(((raw - min) / (max - min)) * 10000) / 100;
    },
    cEntryLabel(entry, idx) {
      if (entry.selectedBench) return entry.selectedBench.name;
      return `Score #${idx + 1}`;
    },
    async submitC() {
      if (!this.user) { this.submitError = "Please log in first."; return; }
      const f = this.submitFormC;
      this.submitting = true; this.submitError = null; this.submitSuccess = null;
      try {
        const args = {};
        if (f.selectedModel) args.modelId = f.selectedModel._id;
        else if (f.isNewModel) {
          if (!f.newModel.name?.trim()) throw new Error("Model name required.");
          if (!f.newModel.provider?.trim()) throw new Error("Provider required.");
          args.newModel = {
            name: f.newModel.name, provider: f.newModel.provider,
            familyTag: f.newModel.familyTag || undefined, tags: f.newModel.tags,
          };
        } else throw new Error("Please pick or create a model.");

        const scores = [];
        for (let i = 0; i < f.scoreEntries.length; i++) {
          const entry = f.scoreEntries[i];
          if (!entry.selectedBench) throw new Error(`Score #${i + 1}: pick a benchmark`);
          const raw = parseFloat(entry.rawScore);
          if (!Number.isFinite(raw)) throw new Error(`Score #${i + 1}: invalid score`);
          if (!entry.sourceUrl?.trim()) throw new Error(`Score #${i + 1}: source URL required`);
          const ts = isoToTimestamp(entry.accessedAt);
          if (!ts) throw new Error(`Score #${i + 1}: invalid 'accessed on' date`);
          scores.push({
            benchId: entry.selectedBench._id, rawScore: raw,
            sourceUrl: entry.sourceUrl, accessedAt: ts,
          });
        }
        args.scores = scores;
        const res = await window.sbConvex.client.mutation(window.sbConvex.api.submissions.submitForModel, args);
        this.submitSuccess = res; this.submitFormC = makeFormC();
      } catch (e) {
        this.submitError = e.message || "Submission failed.";
      } finally { this.submitting = false; }
    },

    submitAnother() {
      this.submitSuccess = null; this.submitError = null;
    },

    // ═══ VOTING (submission scores) ═══
    async castVote(targetId, value) {
      if (!this.user) return;
      const { client, api } = window.sbConvex;
      try {
        await client.mutation(api.votes.cast, { targetId: String(targetId), value });
        if (this.view === "modelDetail") await this._loadModelDetail();
        if (this.view === "benchDetail") await this._loadBenchDetail();
        if (this.view === "submission") await this._loadSubmissionDetail();
      } catch (e) { console.error("Vote failed:", e); }
    },

    // ═══ TAG VOTING ═══
    async voteTag(entityType, entityId, tag, value) {
      if (!this.user) return;
      const { client, api } = window.sbConvex;
      try {
        await client.mutation(api.tagVotes.cast, {
          entityType, entityId: String(entityId), tag, value,
        });
        if (entityType === "bench") await this._loadBenchDetail();
        else await this._loadModelDetail();
      } catch (e) {
        console.error("Tag vote failed:", e);
        this.showToast(e.message || "Tag vote failed", "error");
      }
    },

    async suggestTag(entityType, entityId) {
      const tag = this.tagSuggestInput.trim().toLowerCase();
      if (!tag) return;
      this.tagSuggestInput = ""; this.showTagSuggest = false;
      await this.voteTag(entityType, entityId, tag, 1);
    },

    // ═══ ENTITY VOTING (model/bench existence) ═══
    async voteEntity(entityType, entityId, value) {
      if (!this.user) return;
      const { client, api } = window.sbConvex;
      try {
        await client.mutation(api.entityVotes.cast, {
          entityType, entityId: String(entityId), value,
        });
        if (entityType === "bench") await this._loadBenchDetail();
        else await this._loadModelDetail();
      } catch (e) {
        console.error("Entity vote failed:", e);
        this.showToast(e.message || "Entity vote failed", "error");
      }
    },

    // ═══ QUALITY RATING ═══
    setRating(dimension, value) { this.ratingForm[dimension] = value; },

    async submitRating() {
      if (!this.user || !this.currentBench) return;
      const { client, api } = window.sbConvex;
      try {
        await client.mutation(api.benchQualityRatings.rate, {
          benchId: this.currentBench._id,
          relevance: this.ratingForm.relevance,
          contamination: this.ratingForm.contamination,
          discriminability: this.ratingForm.discriminability,
          reproducibility: this.ratingForm.reproducibility,
          difficulty: this.ratingForm.difficulty,
        });
        this.showRatingForm = false;
        await this._loadBenchDetail();
      } catch (e) {
        console.error("Rating failed:", e);
        this.showToast(e.message || "Rating failed", "error");
      }
    },

    // ═══ BENCH SORT ═══
    get sortedBenches() {
      const sorted = [...this.rankedBenches];
      if (this.benchSortField === "name") {
        sorted.sort((a, b) => this.benchSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
      } else {
        // Default ranking dimension is the Bench Score (effectiveWeight),
        // i.e. quality × difficulty × headroom — the actual ranking weight.
        sorted.sort((a, b) => this.benchSortAsc ? a.effectiveWeight - b.effectiveWeight : b.effectiveWeight - a.effectiveWeight);
      }
      return sorted;
    },

    toggleBenchSort(field) {
      if (this.benchSortField === field) this.benchSortAsc = !this.benchSortAsc;
      else { this.benchSortField = field; this.benchSortAsc = false; }
    },

    // ═══ HELPERS ═══
    qualityColor(score) {
      if (score > 70) return "var(--success)";
      if (score > 40) return "var(--warn)";
      return "var(--danger)";
    },

    // Bench Score (effectiveWeight) lives on the same 0–100 scale as
    // qualityScore but its empirical distribution skews lower because it's
    // a 3-way product. Lower colour thresholds keep the list legible:
    // ≥ 50 is genuinely a top-tier bench, 20–50 is solid, < 20 is weak.
    benchScoreColor(score) {
      if (score >= 50) return "var(--success)";
      if (score >= 20) return "var(--warn)";
      return "var(--danger)";
    },

    formatDate(ts) {
      if (!ts) return "—";
      return new Date(ts).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    },

    truncateUrl(url) {
      try {
        const u = new URL(url);
        return u.hostname + (u.pathname.length > 30 ? u.pathname.slice(0, 30) + "…" : u.pathname);
      } catch { return url; }
    },
  };
}
