/* ═══════════════════════════════════════════
   SUPRABENCH — Main Application
   Uses Alpine.js + GitHubAPI from github-api.js
   ═══════════════════════════════════════════ */

const FALLBACK_DATA = {
  "benchmarks": [
    {
      "slug": "arc-agi",
      "name": "ARC-AGI",
      "subtitle": "Abstraction & Reasoning Corpus",
      "year": 2019,
      "score": 10,
      "tags": [
        "abstract-reasoning",
        "novel-problems"
      ],
      "paperUrl": "https://arxiv.org/abs/1911.01547",
      "repoUrl": "https://github.com/fchollet/ARC-AGI",
      "description": "Measures fluid intelligence through novel visual pattern recognition tasks. Each problem requires identifying abstract transformation rules from input-output grid pairs \u2014 tasks trivial for humans but extremely challenging for AI.",
      "communityVerdict": "Gold standard for measuring genuine reasoning vs pattern matching. Extremely hard to game because each task requires novel abstraction. Low scores across all models confirm its validity.",
      "scores": {
        "DeepSeek R1": {
          "score": 6.0,
          "proof": ""
        },
        "Claude 3.5 Sonnet": {
          "score": 21.0,
          "proof": ""
        },
        "GPT-4o": {
          "score": 5.0,
          "proof": ""
        },
        "Gemini 1.5 Pro": {
          "score": 8.0,
          "proof": ""
        },
        "Llama 3.3 70B": {
          "score": 2.0,
          "proof": ""
        }
      }
    },
    {
      "slug": "chatbot-arena",
      "name": "Chatbot Arena",
      "subtitle": "Human Preference ELO Ratings",
      "year": 2023,
      "score": 10,
      "tags": [
        "general-helpfulness"
      ],
      "paperUrl": "https://arxiv.org/abs/2403.04132",
      "repoUrl": "https://github.com/lm-sys/FastChat",
      "description": "Large-scale crowdsourced platform where users chat with two anonymous models and vote for the better response. Produces ELO-style rankings from hundreds of thousands of human preference comparisons.",
      "communityVerdict": "The closest thing to a \"real world\" benchmark, but susceptible to style over substance bias \u2014 verbose, confident responses often win regardless of accuracy. Category-specific arenas help but demographic bias in voters remains.",
      "scores": {
        "DeepSeek R1": {
          "score": 1358.0,
          "proof": ""
        },
        "Claude 3.5 Sonnet": {
          "score": 1271.0,
          "proof": ""
        },
        "GPT-4o": {
          "score": 1290.0,
          "proof": ""
        },
        "Gemini 1.5 Pro": {
          "score": 1267.0,
          "proof": ""
        },
        "Llama 3.3 70B": {
          "score": 1183.0,
          "proof": ""
        }
      }
    },
    {
      "slug": "gpqa",
      "name": "GPQA",
      "subtitle": "Graduate-Level Google-Proof Q&A",
      "year": 2023,
      "score": 10,
      "tags": [
        "scientific-reasoning",
        "research"
      ],
      "paperUrl": "https://arxiv.org/abs/2311.12022",
      "repoUrl": "https://github.com/idavidrein/gpqa",
      "description": "A challenging dataset of 448 expert-level multiple-choice questions in biology, physics, and chemistry. Questions are designed so that even domain experts only achieve ~65% accuracy, while non-experts score near random chance.",
      "communityVerdict": "Strong benchmark with genuine difficulty. The \"Google-proof\" design makes contamination harder, though the small dataset size is a concern. Trusted by the research community for measuring deep scientific reasoning.",
      "scores": {
        "DeepSeek R1": {
          "score": 71.5,
          "proof": ""
        },
        "Claude 3.5 Sonnet": {
          "score": 65.0,
          "proof": ""
        },
        "GPT-4o": {
          "score": 53.6,
          "proof": ""
        },
        "Gemini 1.5 Pro": {
          "score": 59.1,
          "proof": ""
        },
        "Llama 3.3 70B": {
          "score": 46.7,
          "proof": ""
        }
      }
    },
    {
      "slug": "humaneval",
      "name": "HumanEval",
      "subtitle": "Python Code Generation",
      "year": 2021,
      "score": 10,
      "tags": [
        "coding"
      ],
      "paperUrl": "https://arxiv.org/abs/2107.03374",
      "repoUrl": "https://github.com/openai/human-eval",
      "description": "164 hand-written Python programming problems with function signatures and docstrings. Models generate function bodies which are tested against hidden unit tests.",
      "communityVerdict": "Essentially useless as a benchmark in 2024+. Completely saturated, thoroughly contaminated, and trivially small. Every major model scores 90%+, making it impossible to differentiate capabilities. A historical artifact at this point.",
      "scores": {
        "DeepSeek R1": {
          "score": 96.3,
          "proof": ""
        },
        "Claude 3.5 Sonnet": {
          "score": 93.7,
          "proof": ""
        },
        "GPT-4o": {
          "score": 90.2,
          "proof": ""
        },
        "Gemini 1.5 Pro": {
          "score": 91.5,
          "proof": ""
        },
        "Llama 3.3 70B": {
          "score": 88.4,
          "proof": ""
        }
      }
    },
    {
      "slug": "livecodebench",
      "name": "LiveCodeBench",
      "subtitle": "Contamination-Free Coding Eval",
      "year": 2024,
      "score": 10,
      "tags": [
        "algorithms",
        "coding"
      ],
      "paperUrl": "https://arxiv.org/abs/2403.07974",
      "repoUrl": "https://github.com/LiveCodeBench/LiveCodeBench",
      "description": "Continuously updated coding benchmark using problems from competitive programming contests published after model training cutoffs. Eliminates data contamination by design.",
      "communityVerdict": "Clever approach to contamination. The rolling time window is its biggest strength. However, competitive programming measures a narrow slice of coding ability, and difficulty calibration varies across contest sources.",
      "scores": {
        "DeepSeek R1": {
          "score": 65.9,
          "proof": ""
        },
        "Claude 3.5 Sonnet": {
          "score": 51.3,
          "proof": ""
        },
        "GPT-4o": {
          "score": 45.2,
          "proof": ""
        },
        "Gemini 1.5 Pro": {
          "score": 43.8,
          "proof": ""
        },
        "Llama 3.3 70B": {
          "score": 33.1,
          "proof": ""
        }
      }
    },
    {
      "slug": "mmlu",
      "name": "MMLU",
      "subtitle": "Massive Multitask Language Understanding",
      "year": 2020,
      "score": 10,
      "tags": [
        "knowledge-breadth"
      ],
      "paperUrl": "https://arxiv.org/abs/2009.03300",
      "repoUrl": "https://github.com/hendrycks/test",
      "description": "14,042 multiple-choice questions across 57 academic subjects from STEM to humanities. Originally designed to measure breadth of knowledge and reasoning across diverse domains.",
      "communityVerdict": "Once the standard benchmark, now considered deeply compromised. Massive contamination in training data, inconsistent question quality, and ceiling effects make differences between top models meaningless. Scores above 85% reflect memorization more than understanding.",
      "scores": {
        "DeepSeek R1": {
          "score": 90.8,
          "proof": ""
        },
        "Claude 3.5 Sonnet": {
          "score": 88.7,
          "proof": ""
        },
        "GPT-4o": {
          "score": 88.7,
          "proof": ""
        },
        "Gemini 1.5 Pro": {
          "score": 85.9,
          "proof": ""
        },
        "Llama 3.3 70B": {
          "score": 86.0,
          "proof": ""
        }
      }
    },
    {
      "slug": "swe-bench-verified",
      "name": "SWE-bench Verified",
      "subtitle": "Real-World Software Engineering",
      "year": 2023,
      "score": 10,
      "tags": [
        "coding",
        "debugging"
      ],
      "paperUrl": "https://arxiv.org/abs/2310.06770",
      "repoUrl": "https://github.com/princeton-nlp/SWE-bench",
      "description": "500 human-verified software engineering tasks sourced from real GitHub issues across popular Python repos. Models must understand codebases, diagnose bugs, and generate working patches.",
      "communityVerdict": "Important real-world benchmark but high gaming risk due to training data contamination \u2014 many source repos are in LLM training sets. The \"Verified\" subset helps but scaffolding differences across evaluations make comparison difficult.",
      "scores": {
        "DeepSeek R1": {
          "score": 49.2,
          "proof": ""
        },
        "Claude 3.5 Sonnet": {
          "score": 50.8,
          "proof": ""
        },
        "GPT-4o": {
          "score": 38.8,
          "proof": ""
        },
        "Gemini 1.5 Pro": {
          "score": 36.2,
          "proof": ""
        },
        "Llama 3.3 70B": {
          "score": 26.5,
          "proof": ""
        }
      }
    }
  ],
  "models": ['DeepSeek R1', 'Claude 3.5 Sonnet', 'GPT-4o', 'Gemini 1.5 Pro', 'Llama 3.3 70B']
};

/* ── Alpine.js App ── */
function supraBench() {
    return {
        view: 'models',
        previousView: 'models',
        benchmarks: [],
        activeTags: [],
        allTags: [],
        indexSort: { key: 'score', dir: -1 },
        currentBenchmark: null,
        currentBenchmarkPRs: [],
        currentModel: null,
        selectedDiscussionModel: null,

        // Submit state
        submitStep: 1,
        formType: 'new', // 'new' or 'score'
        ghToken: null,
        ghUser: null,
        submitting: false,
        submitError: '',
        prUrl: '',
        form: {
            name: '', subtitle: '', year: '', paperUrl: '', repoUrl: '',
            description: '', communityVerdict: '',
            capabilityTags: [], useCaseTags: [],
            gamingRisk: 50,
            modelScores: [{ model: '', score: '', proof: '' }]
        },
        scoreForm: {
            benchmarkSlug: '',
            model: '',
            score: '',
            proof: '',
            note: ''
        },

        /* ── Init ── */
        async init() {
            try {
                const r = await fetch(CONFIG.dataUrl);
                if (r.ok) {
                    const d = await r.json();
                    this.benchmarks = d.benchmarks || [];
                } else throw new Error();
            } catch {
                this.benchmarks = FALLBACK_DATA.benchmarks;
            }

            // Derive tags from data
            const tagSet = new Set();
            this.benchmarks.forEach(b => (b.tags || []).forEach(t => tagSet.add(t)));
            this.allTags = [...tagSet].sort();

            // Handle OAuth callback
            const params = new URLSearchParams(window.location.search);
            if (params.has('code')) {
                try {
                    this.ghToken = await GitHubAPI.exchangeCode(params.get('code'));
                    this.ghUser = await GitHubAPI.getUser(this.ghToken);
                    this.submitStep = 2;
                    this.view = 'submit';
                    window.history.replaceState({}, '', window.location.pathname);
                } catch (e) { console.error('OAuth error:', e); }
            }
        },

        /* ── Navigation ── */
        navigate(v) {
            this.previousView = this.view;
            this.view = v;
            window.scrollTo(0, 0);
        },

        openDetail(slug) {
            this.currentBenchmark = this.benchmarks.find(b => b.slug === slug);
            this.currentBenchmarkPRs = [];
            this.selectedDiscussionModel = null;
            
            GitHubAPI.getOpenPRsForBenchmark(slug).then(prs => {
                this.currentBenchmarkPRs = prs;
            }).catch(console.error);

            this.previousView = this.view;
            this.view = 'detail';
            window.scrollTo(0, 0);
        },

        openModel(name) {
            this.currentModel = name;
            this.previousView = this.view;
            this.view = 'modelDetail';
            window.scrollTo(0, 0);
        },

        /* ── Tag filtering ── */
        toggleTag(t) {
            const i = this.activeTags.indexOf(t);
            if (i >= 0) this.activeTags.splice(i, 1);
            else this.activeTags.push(t);
        },

        get filteredBenchmarks() {
            if (!this.activeTags.length) return this.benchmarks;
            return this.benchmarks.filter(b =>
                this.activeTags.some(t => (b.tags || []).includes(t))
            );
        },

        /* ── Reality Score: score-weighted model ranking ── */
        get rankedModels() {
            const allB = this.benchmarks;
            const fb = this.filteredBenchmarks;
            if (!allB.length) return [];
            const modelNames = new Set();
            allB.forEach(b => Object.keys(b.scores || {}).forEach(m => modelNames.add(m)));
            return [...modelNames].map(name => {
                let gSum = 0, gTotal = 0;
                allB.forEach(b => {
                    if (b.scores?.[name] !== undefined) {
                        const w = Math.max(1, b.score);
                        let raw = b.scores[name];
                        let score = typeof raw === "object" ? raw.score : raw;
                        if (b.slug === 'chatbot-arena') score = (score - 1000) / 5;
                        gSum += score * w;
                        gTotal += w;
                    }
                });
                const realityScore = gTotal ? gSum / gTotal : 0;

                let fSum = 0, fTotal = 0;
                fb.forEach(b => {
                    if (b.scores?.[name] !== undefined) {
                        const w = Math.max(1, b.score);
                        let raw = b.scores[name];
                        let score = typeof raw === "object" ? raw.score : raw;
                        if (b.slug === 'chatbot-arena') score = (score - 1000) / 5;
                        fSum += score * w;
                        fTotal += w;
                    }
                });
                const filteredScore = fTotal ? fSum / fTotal : null;

                return { name, realityScore, filteredScore };
            }).sort((a, b) => {
                const valA = this.activeTags.length && a.filteredScore !== null ? a.filteredScore : a.realityScore;
                const valB = this.activeTags.length && b.filteredScore !== null ? b.filteredScore : b.realityScore;
                return valB - valA;
            });
        },

        /* ── Index sorting ── */
        get sortedBenchmarks() {
            const k = this.indexSort.key, d = this.indexSort.dir;
            return [...this.benchmarks].sort((a, b) => {
                const av = a[k], bv = b[k];
                if (typeof av === 'string') return d * av.localeCompare(bv);
                return d * (av - bv);
            });
        },

        sortIndex(key) {
            if (this.indexSort.key === key) this.indexSort.dir *= -1;
            else { this.indexSort.key = key; this.indexSort.dir = key === 'score' ? -1 : 1; }
        },

        /* ── Helpers ── */
        scoreColor(s) {
            if (s >= 50) return '#44ff88';
            if (s >= 20) return '#E5FE40';
            if (s >= 0)  return '#ffaa44';
            return '#ff4444';
        },

        addTag(field, input) {
            const v = input.value.trim().toLowerCase().replace(/,$/, '');
            if (v && !this.form[field].includes(v)) this.form[field].push(v);
            input.value = '';
        },

        /* ── GitHub auth ── */
        githubLogin() { GitHubAPI.startLogin(); },
        githubLogout() { this.ghToken = null; this.ghUser = null; this.submitStep = 1; },

        /* ── Submit PR ── */
        async submitBenchmark() {
            if (!this.form.name || !this.form.description) {
                this.submitError = 'Name and description are required.';
                return;
            }
            this.submitting = true;
            this.submitError = '';
            try {
                this.prUrl = await GitHubAPI.createPR(this.ghToken, this.form);
                this.submitStep = 3;
            } catch (e) {
                this.submitError = 'Failed to create PR: ' + (e.message || e);
                console.error(e);
            }
            this.submitting = false;
        },

        async submitScore() {
            if (!this.scoreForm.benchmarkSlug || !this.scoreForm.model || !this.scoreForm.score) {
                this.submitError = 'Benchmark, model, and score are required.';
                return;
            }
            this.submitting = true;
            this.submitError = '';
            try {
                this.prUrl = await GitHubAPI.addScorePR(this.ghToken, this.scoreForm);
                this.submitStep = 3;
            } catch (e) {
                this.submitError = 'Failed to create PR: ' + (e.message || e);
                console.error(e);
            }
            this.submitting = false;
        },

        resetForm() {
            this.form = {
                name: '', subtitle: '', year: '', paperUrl: '', repoUrl: '',
                description: '', communityVerdict: '',
                capabilityTags: [], useCaseTags: [],
                modelScores: [{ model: '', score: '', proof: '' }]
            };
            this.scoreForm = { benchmarkSlug: '', model: '', score: '', proof: '', note: '' };
            this.submitStep = 2;
            this.submitError = '';
            this.prUrl = '';
        }
    };
}
