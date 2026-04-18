// ══════════════════════════════════════════
// SupraBench Alpine.js Application
// ══════════════════════════════════════════

const OFFICIAL_DOMAINS = [
  "lmsys.org", "chat.lmsys.org", "swebench.com",
  "paperswithcode.com", "huggingface.co", "scale.com",
  "opencompass.org", "evalplus.github.io", "arxiv.org",
];

function checkOfficialUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
  } catch { return false; }
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
    activeTags: [],
    currentModel: null,
    currentBench: null,
    currentSubmission: null,

    // ── Auth ──
    user: null,

    // ── Submit Form ──
    submitForm: {
      benchSearch: "",
      benchResults: [],
      selectedBench: null,
      isNewBench: false,
      newBench: { name: "", description: "", url: "", scaleMin: 0, scaleMax: 100, tags: [] },
      newBenchTagInput: "",
      isOfficialDetected: false,

      modelSearch: "",
      modelResults: [],
      selectedModel: null,
      isNewModel: false,
      newModel: { name: "", provider: "", familyTag: "", tags: [] },
      newModelTagInput: "",

      rawScore: "",
      normalizedPreview: null,
      sourceUrl: "",
    },
    submitting: false,
    submitError: null,
    submitSuccess: null,

    // ── Bench Detail ──
    myRating: null,
    ratingForm: { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0 },
    showRatingForm: false,
    showAllSubmissions: false,
    addTagInput: "",
    showAddTag: false,

    // ── Sort ──
    benchSortField: "quality",
    benchSortAsc: false,

    // ── Subscriptions ──
    _unsubscribers: [],

    // ═══ INIT ═══
    async init() {
      const { client, api, initAuth } = window.sbConvex;

      // Handle OAuth callback / restore session
      await initAuth();

      // Parse initial hash
      this._parseHash();
      window.addEventListener("hashchange", () => this._parseHash());

      // Listen for auth state changes to re-subscribe
      window.addEventListener("sb-auth-change", () => {
        // User query will auto-refresh via subscription
      });

      // Subscribe to tags
      this._subscribe(api.tags.listAll, {}, (data) => {
        this.allTags = (data || []).map(t => t.tag);
      });

      // Subscribe to user
      this._subscribe(api.users.viewer, {}, (data) => {
        this.user = data;
      });

      // Subscribe to ranked models
      this._subscribe(api.models.listRanked, {}, (data) => {
        this.rankedModels = data || [];
      });

      // Subscribe to ranked benches
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
      // Any route change closes the mobile drawer.
      this.mobileMenuOpen = false;
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
      } else if (parts[0] === "submission" && parts[1]) {
        this.view = "submission";
        this.currentSubmissionId = parts[1];
        this._loadSubmissionDetail();
      }
    },

    navigate(view, params) {
      this.previousView = this.view;
      let hash = view;
      if (params?.slug) hash += "/" + params.slug;
      if (params?.id) hash += "/" + params.id;
      window.location.hash = hash;
    },

    // ═══ DATA LOADING ═══
    async _loadModelDetail() {
      const { client, api } = window.sbConvex;
      try {
        this.currentModel = await client.query(api.models.getBySlug, { slug: this.currentModelSlug });
      } catch (e) {
        console.error("Failed to load model:", e);
      }
    },

    async _loadBenchDetail() {
      const { client, api } = window.sbConvex;
      try {
        this.currentBench = await client.query(api.benches.getBySlug, { slug: this.currentBenchSlug });
        if (this.currentBench && this.user) {
          this.myRating = await client.query(api.benchQualityRatings.getMyRating, { benchId: this.currentBench._id });
          if (this.myRating) {
            this.ratingForm = {
              relevance: this.myRating.relevance,
              contamination: this.myRating.contamination,
              discriminability: this.myRating.discriminability,
              reproducibility: this.myRating.reproducibility,
            };
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

    // ═══ TAG FILTERING ═══
    toggleTag(tag) {
      const idx = this.activeTags.indexOf(tag);
      if (idx >= 0) {
        this.activeTags.splice(idx, 1);
      } else {
        this.activeTags.push(tag);
      }
      this._loadFilteredModels();
    },

    async _loadFilteredModels() {
      if (this.activeTags.length === 0) {
        // Use the subscription data
        return;
      }
      const { client, api } = window.sbConvex;
      try {
        this.rankedModels = await client.query(api.models.listRankedWithFilter, { activeTags: this.activeTags });
      } catch (e) {
        console.error("Failed to load filtered models:", e);
      }
    },

    // ═══ AUTH ═══
    async login() {
      try {
        await window.sbConvex.signIn("google");
      } catch (e) {
        console.error("Login failed:", e);
      }
    },

    async logout() {
      await window.sbConvex.signOut();
      this.user = null;
    },

    // ═══ SUBMIT FORM ═══
    async searchBenches() {
      if (this.submitForm.benchSearch.length < 2) {
        this.submitForm.benchResults = [];
        return;
      }
      const { client, api } = window.sbConvex;
      try {
        this.submitForm.benchResults = await client.query(api.benches.search, { query: this.submitForm.benchSearch });
      } catch (e) {
        this.submitForm.benchResults = [];
      }
    },

    selectBench(bench) {
      this.submitForm.selectedBench = bench;
      this.submitForm.benchSearch = bench.name;
      this.submitForm.benchResults = [];
      this.submitForm.isNewBench = false;
    },

    startNewBench() {
      this.submitForm.isNewBench = true;
      this.submitForm.selectedBench = null;
      this.submitForm.newBench.name = this.submitForm.benchSearch;
      this.submitForm.benchResults = [];
    },

    checkBenchUrl() {
      this.submitForm.isOfficialDetected = checkOfficialUrl(this.submitForm.newBench.url);
    },

    addBenchTag() {
      const tag = this.submitForm.newBenchTagInput.trim().toLowerCase();
      if (tag && !this.submitForm.newBench.tags.includes(tag)) {
        this.submitForm.newBench.tags.push(tag);
      }
      this.submitForm.newBenchTagInput = "";
    },

    removeBenchTag(idx) {
      this.submitForm.newBench.tags.splice(idx, 1);
    },

    async searchModels() {
      if (this.submitForm.modelSearch.length < 2) {
        this.submitForm.modelResults = [];
        return;
      }
      const { client, api } = window.sbConvex;
      try {
        this.submitForm.modelResults = await client.query(api.models.search, { query: this.submitForm.modelSearch });
      } catch (e) {
        this.submitForm.modelResults = [];
      }
    },

    selectModel(model) {
      this.submitForm.selectedModel = model;
      this.submitForm.modelSearch = model.name;
      this.submitForm.modelResults = [];
      this.submitForm.isNewModel = false;
    },

    startNewModel() {
      this.submitForm.isNewModel = true;
      this.submitForm.selectedModel = null;
      this.submitForm.newModel.name = this.submitForm.modelSearch;
      this.submitForm.modelResults = [];
    },

    addModelTag() {
      const tag = this.submitForm.newModelTagInput.trim().toLowerCase();
      if (tag && !this.submitForm.newModel.tags.includes(tag)) {
        this.submitForm.newModel.tags.push(tag);
      }
      this.submitForm.newModelTagInput = "";
    },

    removeModelTag(idx) {
      this.submitForm.newModel.tags.splice(idx, 1);
    },

    get currentScaleMin() {
      if (this.submitForm.selectedBench) return this.submitForm.selectedBench.scaleMin;
      if (this.submitForm.isNewBench) return this.submitForm.newBench.scaleMin;
      return 0;
    },

    get currentScaleMax() {
      if (this.submitForm.selectedBench) return this.submitForm.selectedBench.scaleMax;
      if (this.submitForm.isNewBench) return this.submitForm.newBench.scaleMax;
      return 100;
    },

    updateNormalizePreview() {
      const raw = parseFloat(this.submitForm.rawScore);
      if (isNaN(raw)) {
        this.submitForm.normalizedPreview = null;
        return;
      }
      const min = this.currentScaleMin;
      const max = this.currentScaleMax;
      if (max === min) {
        this.submitForm.normalizedPreview = 0;
        return;
      }
      this.submitForm.normalizedPreview = Math.round(((raw - min) / (max - min)) * 10000) / 100;
    },

    async submitScore() {
      if (!this.user) {
        this.submitError = "Please log in first.";
        return;
      }
      this.submitting = true;
      this.submitError = null;
      this.submitSuccess = null;

      const { client, api } = window.sbConvex;

      try {
        const args = {
          rawScore: parseFloat(this.submitForm.rawScore),
          sourceUrl: this.submitForm.sourceUrl,
        };

        // Bench
        if (this.submitForm.selectedBench) {
          args.benchId = this.submitForm.selectedBench._id;
        } else if (this.submitForm.isNewBench) {
          args.newBench = {
            name: this.submitForm.newBench.name,
            description: this.submitForm.newBench.description,
            url: this.submitForm.newBench.url,
            scaleMin: parseFloat(this.submitForm.newBench.scaleMin) || 0,
            scaleMax: parseFloat(this.submitForm.newBench.scaleMax) || 100,
            tags: this.submitForm.newBench.tags,
          };
        } else {
          this.submitError = "Please select or create a benchmark.";
          this.submitting = false;
          return;
        }

        // Model
        if (this.submitForm.selectedModel) {
          args.modelId = this.submitForm.selectedModel._id;
        } else if (this.submitForm.isNewModel) {
          args.newModel = {
            name: this.submitForm.newModel.name,
            provider: this.submitForm.newModel.provider,
            familyTag: this.submitForm.newModel.familyTag || undefined,
            tags: this.submitForm.newModel.tags,
          };
        } else {
          this.submitError = "Please select or create a model.";
          this.submitting = false;
          return;
        }

        const scoreId = await client.mutation(api.submissions.submit, args);
        this.submitSuccess = { scoreId };
        this._resetSubmitForm();
      } catch (e) {
        this.submitError = e.message || "Submission failed.";
      } finally {
        this.submitting = false;
      }
    },

    _resetSubmitForm() {
      this.submitForm.benchSearch = "";
      this.submitForm.benchResults = [];
      this.submitForm.selectedBench = null;
      this.submitForm.isNewBench = false;
      this.submitForm.newBench = { name: "", description: "", url: "", scaleMin: 0, scaleMax: 100, tags: [] };
      this.submitForm.newBenchTagInput = "";
      this.submitForm.isOfficialDetected = false;
      this.submitForm.modelSearch = "";
      this.submitForm.modelResults = [];
      this.submitForm.selectedModel = null;
      this.submitForm.isNewModel = false;
      this.submitForm.newModel = { name: "", provider: "", familyTag: "", tags: [] };
      this.submitForm.newModelTagInput = "";
      this.submitForm.rawScore = "";
      this.submitForm.normalizedPreview = null;
      this.submitForm.sourceUrl = "";
    },

    submitAnother() {
      this.submitSuccess = null;
      this.submitError = null;
    },

    // ═══ VOTING ═══
    async castVote(targetId, value) {
      if (!this.user) return;
      const { client, api } = window.sbConvex;
      try {
        await client.mutation(api.votes.cast, { targetId: String(targetId), value });
        // Reload detail data
        if (this.view === "modelDetail") await this._loadModelDetail();
        if (this.view === "benchDetail") await this._loadBenchDetail();
        if (this.view === "submission") await this._loadSubmissionDetail();
      } catch (e) {
        console.error("Vote failed:", e);
      }
    },

    // ═══ QUALITY RATING ═══
    setRating(dimension, value) {
      this.ratingForm[dimension] = value;
    },

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
        });
        this.showRatingForm = false;
        await this._loadBenchDetail();
      } catch (e) {
        console.error("Rating failed:", e);
      }
    },

    // ═══ TAG EDITING ═══
    async addBenchDetailTag() {
      const tag = this.addTagInput.trim().toLowerCase();
      if (!tag || !this.currentBench) return;
      const { client, api } = window.sbConvex;
      try {
        await client.mutation(api.benches.addTag, { benchId: this.currentBench._id, tag });
        this.addTagInput = "";
        this.showAddTag = false;
        await this._loadBenchDetail();
      } catch (e) {
        console.error("Add tag failed:", e);
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
      if (this.benchSortField === field) {
        this.benchSortAsc = !this.benchSortAsc;
      } else {
        this.benchSortField = field;
        this.benchSortAsc = false;
      }
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
      } catch {
        return url;
      }
    },
  };
}
