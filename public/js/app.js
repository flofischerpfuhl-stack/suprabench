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

    // The following are read by the (currently HTML-commented) subscription
    // panel. Defaults shipped now so uncommenting the panel doesn't blow up
    // before the backend wiring lands.
    mySubscription: null,
    myApiKeys: [],
    apiKeyLimit: 3,
    newKeyJustCreated: null,

    // About-page Q&A: a Set of question-IDs that are currently expanded.
    // Default: first question open so the page isn't a wall of buttons.
    aboutOpen: new Set(["q1"]),

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

    // ── Disabled API actions (will be wired up when api.future.ts ships) ──
    // These exist so the (currently HTML-commented) subscription panel
    // doesn't throw on Alpine init if someone uncomments only part of it.
    async manageBilling() { this.showToast("API not yet live — join the waitlist!", "info"); },
    async openCreateKeyModal() { this.showToast("API not yet live — join the waitlist!", "info"); },
    async revokeApiKey() { this.showToast("API not yet live — join the waitlist!", "info"); },
    async copyNewKey() {
      if (!this.newKeyJustCreated) return;
      try { await navigator.clipboard.writeText(this.newKeyJustCreated); this.showToast("Copied.", "info"); }
      catch { this.showToast("Copy failed — select & copy manually.", "error"); }
    },

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
      const ids = ["q1","q2","q3","q4","q5","q6","q7","q8","q9"];
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
      if (!q) return this.rankedModels;
      return this.rankedModels.filter(m =>
        m.name.toLowerCase().includes(q) ||
        (m.provider || "").toLowerCase().includes(q) ||
        (m.tags || []).some(t => t.includes(q))
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
        alert(e.message || "Tag vote failed");
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
        alert(e.message || "Entity vote failed");
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
        alert(e.message || "Rating failed");
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
