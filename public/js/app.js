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

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isoToTimestamp(iso) {
  // Treat as UTC midnight to keep timestamps stable across timezones
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00Z");
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

let _entryCounter = 0;

function makeEmptySubmitForm() {
  return {
    benchSearch: "",
    benchResults: [],
    selectedBench: null,
    isNewBench: false,
    newBench: { name: "", description: "", url: "", scaleMin: 0, scaleMax: 100, tags: [] },
    newBenchTagInput: "",
    newBenchLastFlashIdx: -1,
    isOfficialDetected: false,
    scoreEntries: [makeEmptyScoreEntry()],
  };
}

function makeEmptyScoreEntry() {
  _entryCounter += 1;
  return {
    _id: _entryCounter,
    collapsed: false,
    modelSearch: "",
    modelResults: [],
    selectedModel: null,
    isNewModel: false,
    newModel: { name: "", provider: "", familyTag: "", tags: [] },
    newModelTagInput: "",
    newModelLastFlashIdx: -1,
    rawScore: "",
    normalizedPreview: null,
    sourceUrl: "",
    accessedAt: todayIsoDate(),
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
    activeTags: [],
    tagSearch: "",
    modelListSearch: "",
    benchListSearch: "",
    currentModel: null,
    currentBench: null,
    currentSubmission: null,
    currentBenchTagVotes: [],
    currentModelTagVotes: [],

    // ── Auth ──
    user: null,

    // ── Submit Form ──
    submitForm: makeEmptySubmitForm(),
    submitting: false,
    submitError: null,
    submitSuccess: null,

    // ── Bench Detail ──
    myRating: null,
    ratingForm: { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0 },
    showRatingForm: false,
    showAllSubmissions: false,
    showTagSuggest: false,
    tagSuggestInput: "",

    // ── Sort ──
    benchSortField: "quality",
    benchSortAsc: false,

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

      this._subscribe(api.users.viewer, {}, (data) => {
        this.user = data;
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
        if (this.currentModel) {
          this.currentModelTagVotes = await client.query(api.tagVotes.listForEntity, {
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
          if (this.user) {
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

    // ═══ TAG FILTERING (model list) ═══
    toggleTag(tag) {
      const idx = this.activeTags.indexOf(tag);
      if (idx >= 0) this.activeTags.splice(idx, 1);
      else this.activeTags.push(tag);
      this._loadFilteredModels();
    },

    async _loadFilteredModels() {
      if (this.activeTags.length === 0) return; // subscription drives it
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
      // Compact view: if no search and many tags, show only the top N until expanded.
      const all = this.filteredAllTags;
      if (this.tagSearch || all.length <= 20) return all;
      return all.slice(0, 20);
    },

    get hasMoreTags() {
      return !this.tagSearch && this.allTags.length > 20;
    },

    // ═══ LIST SEARCH (client-side filter) ═══
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

    // ═══ SUBMIT FORM — Bench section ═══
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

    // Triggered on any keystroke; commits the buffered word as a tag when
    // the user types comma or semicolon.
    onTagInput(target, container) {
      const v = container[target];
      // capture "<word>[,;]" possibly with trailing space
      const m = v.match(/^(.+?)\s*[,;]+\s*$/);
      if (m) {
        this._commitTag(m[1], container, target);
      }
    },

    onTagKeydown(e, target, container) {
      if (e.key === "Enter" || e.key === "," || e.key === ";") {
        e.preventDefault();
        const raw = container[target];
        const v = raw.replace(/[,;]+\s*$/, "").trim();
        if (v) this._commitTag(v, container, target);
        else container[target] = "";
      }
    },

    _commitTag(raw, container, inputField) {
      const t = raw.trim().toLowerCase().replace(/[,;]+$/g, "").trim();
      container[inputField] = "";
      if (!t || t.length > 30) return;
      if (container.tags.includes(t)) return;
      container.tags.push(t);
      // visual flash on newest chip
      const idx = container.tags.length - 1;
      const flashKey = inputField.replace("Input", "LastFlashIdx");
      if (flashKey in container) {
        container[flashKey] = idx;
        const ref = container; // capture
        setTimeout(() => { if (ref[flashKey] === idx) ref[flashKey] = -1; }, 600);
      }
    },

    removeBenchTag(idx) {
      this.submitForm.newBench.tags.splice(idx, 1);
    },

    // ═══ SUBMIT FORM — Score entries ═══
    addScoreEntry() {
      // Collapse all existing entries, open the new one
      for (const e of this.submitForm.scoreEntries) e.collapsed = true;
      this.submitForm.scoreEntries.push(makeEmptyScoreEntry());
    },

    removeScoreEntry(entry) {
      const idx = this.submitForm.scoreEntries.indexOf(entry);
      if (idx >= 0 && this.submitForm.scoreEntries.length > 1) {
        this.submitForm.scoreEntries.splice(idx, 1);
      }
    },

    toggleScoreEntry(entry) {
      entry.collapsed = !entry.collapsed;
    },

    async searchModelsForEntry(entry) {
      if (entry.modelSearch.length < 2) {
        entry.modelResults = [];
        return;
      }
      const { client, api } = window.sbConvex;
      try {
        entry.modelResults = await client.query(api.models.search, { query: entry.modelSearch });
      } catch (e) {
        entry.modelResults = [];
      }
    },

    selectModelForEntry(entry, model) {
      entry.selectedModel = model;
      entry.modelSearch = model.name;
      entry.modelResults = [];
      entry.isNewModel = false;
    },

    startNewModelForEntry(entry) {
      entry.isNewModel = true;
      entry.selectedModel = null;
      entry.newModel.name = entry.modelSearch;
      entry.modelResults = [];
    },

    removeModelTag(entry, idx) {
      entry.newModel.tags.splice(idx, 1);
    },

    scaleMinForEntry() {
      if (this.submitForm.selectedBench) return this.submitForm.selectedBench.scaleMin;
      if (this.submitForm.isNewBench) return parseFloat(this.submitForm.newBench.scaleMin) || 0;
      return 0;
    },

    scaleMaxForEntry() {
      if (this.submitForm.selectedBench) return this.submitForm.selectedBench.scaleMax;
      if (this.submitForm.isNewBench) return parseFloat(this.submitForm.newBench.scaleMax) || 100;
      return 100;
    },

    updateNormalizePreview(entry) {
      const raw = parseFloat(entry.rawScore);
      if (isNaN(raw)) {
        entry.normalizedPreview = null;
        return;
      }
      const min = this.scaleMinForEntry();
      const max = this.scaleMaxForEntry();
      if (max === min) { entry.normalizedPreview = 0; return; }
      entry.normalizedPreview = Math.round(((raw - min) / (max - min)) * 10000) / 100;
    },

    entryLabel(entry, idx) {
      if (entry.selectedModel) return entry.selectedModel.name;
      if (entry.isNewModel && entry.newModel.name) return entry.newModel.name + " (new)";
      return `Score #${idx + 1}`;
    },

    async submitScores() {
      if (!this.user) {
        this.submitError = "Please log in first.";
        return;
      }
      this.submitting = true;
      this.submitError = null;
      this.submitSuccess = null;

      const { client, api } = window.sbConvex;

      try {
        const args = {};
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
          throw new Error("Please select or create a benchmark.");
        }

        // Score entries
        const scores = [];
        for (let i = 0; i < this.submitForm.scoreEntries.length; i++) {
          const entry = this.submitForm.scoreEntries[i];
          const e = {};
          if (entry.selectedModel) {
            e.modelId = entry.selectedModel._id;
          } else if (entry.isNewModel) {
            if (!entry.newModel.name?.trim()) throw new Error(`Score #${i + 1}: model name required`);
            if (!entry.newModel.provider?.trim()) throw new Error(`Score #${i + 1}: provider required`);
            e.newModel = {
              name: entry.newModel.name,
              provider: entry.newModel.provider,
              familyTag: entry.newModel.familyTag || undefined,
              tags: entry.newModel.tags,
            };
          } else {
            throw new Error(`Score #${i + 1}: please select or create a model`);
          }
          const raw = parseFloat(entry.rawScore);
          if (!Number.isFinite(raw)) throw new Error(`Score #${i + 1}: invalid score`);
          e.rawScore = raw;
          if (!entry.sourceUrl?.trim()) throw new Error(`Score #${i + 1}: source URL required`);
          e.sourceUrl = entry.sourceUrl;
          const accessedTs = isoToTimestamp(entry.accessedAt);
          if (!accessedTs) throw new Error(`Score #${i + 1}: invalid 'accessed on' date`);
          e.accessedAt = accessedTs;
          scores.push(e);
        }
        args.scores = scores;

        const res = await client.mutation(api.submissions.submitMany, args);
        this.submitSuccess = res;
        this._resetSubmitForm();
      } catch (e) {
        this.submitError = e.message || "Submission failed.";
      } finally {
        this.submitting = false;
      }
    },

    _resetSubmitForm() {
      this.submitForm = makeEmptySubmitForm();
    },

    submitAnother() {
      this.submitSuccess = null;
      this.submitError = null;
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
      } catch (e) {
        console.error("Vote failed:", e);
      }
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
      this.tagSuggestInput = "";
      this.showTagSuggest = false;
      await this.voteTag(entityType, entityId, tag, 1);
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
      } catch {
        return url;
      }
    },
  };
}
