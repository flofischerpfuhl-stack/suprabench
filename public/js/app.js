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
  };
}
function makeEmptyModel() {
  return {
    name: "", provider: "", familyTag: "",
    tags: [], tagInput: "", lastFlashIdx: -1,
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
    showAllSubmissions: false,
    showTagSuggest: false,
    tagSuggestInput: "",

    // ── Sort ──
    benchSortField: "quality",
    benchSortAsc: false,

    // ── Mobile expand state for list rows ──
    expandedListRows: {}, // { [id]: true }

    // ── Subscriptions ──
    _unsubscribers: [],

    // ═══ INIT ═══
    async init() {
      const { client, api, initAuth } = window.sbConvex;

      await initAuth();

      this._parseHash();
      window.addEventListener("hashchange", () => this._parseHash());

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

      this._subscribe(api.tags.listAll, {}, (data) => {
        this.allTags = (data || []).map(t => t.tag);
      });

      this._subscribe(api.models.listProviders, {}, (data) => {
        this.allProviders = data || [];
      });

      this._subscribe(api.models.listFamilyTags, {}, (data) => {
        this.allFamilyTags = data || [];
      });

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

      this._subscribe(api.models.listRanked, {}, (data) => {
        this.rankedModels = data || [];
      });

      this._subscribe(api.benches.listRanked, {}, (data) => {
        this.rankedBenches = data || [];
      });
    },

    _subscribe(fnRef, args, callback) {
      const unsub = window.sbConvex.client.onUpdate(fnRef, args, callback);
      this._unsubscribers.push(unsub);
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
      if (!this.user) { this.profileData = null; return; }
      const { client, api } = window.sbConvex;
      try {
        this.profileData = await client.query(api.users.myActivity, {});
        this.profileSubmissionLimit = 25;
      } catch (e) {
        console.error("Failed to load profile:", e);
      }
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
        sorted.sort((a, b) => this.benchSortAsc ? a.qualityScore - b.qualityScore : b.qualityScore - a.qualityScore);
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
