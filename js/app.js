/* ═══════════════════════════════════════════
   SUPRABENCH — Main Application
   Uses Alpine.js + GitHubAPI from github-api.js
   ═══════════════════════════════════════════ */

const FALLBACK_DATA = {
    benchmarks: [
        {
            slug: 'gpqa', name: 'GPQA', subtitle: 'Graduate-Level Google-Proof Q&A', year: 2023,
            trust: 4.1, gamingRisk: 18,
            tags: ['scientific-reasoning', 'research'],
            paperUrl: 'https://arxiv.org/abs/2311.12022',
            repoUrl: 'https://github.com/idavidrein/gpqa',
            description: 'A challenging dataset of 448 expert-level multiple-choice questions in biology, physics, and chemistry. Questions are designed so that even domain experts only achieve ~65% accuracy, while non-experts score near random chance.',
            communityVerdict: 'Strong benchmark with genuine difficulty. The "Google-proof" design makes contamination harder, though the small dataset size is a concern. Trusted by the research community for measuring deep scientific reasoning.',
            scores: { 'DeepSeek R1': 71.5, 'Claude 3.5 Sonnet': 65.0, 'GPT-4o': 53.6, 'Gemini 1.5 Pro': 59.1, 'Llama 3.3 70B': 46.7 }
        },
        {
            slug: 'arc-agi', name: 'ARC-AGI', subtitle: 'Abstraction & Reasoning Corpus', year: 2019,
            trust: 4.4, gamingRisk: 9,
            tags: ['abstract-reasoning', 'novel-problems'],
            paperUrl: 'https://arxiv.org/abs/1911.01547',
            repoUrl: 'https://github.com/fchollet/ARC-AGI',
            description: 'Measures fluid intelligence through novel visual pattern recognition tasks. Each problem requires identifying abstract transformation rules from input-output grid pairs — tasks trivial for humans but extremely challenging for AI.',
            communityVerdict: 'Gold standard for measuring genuine reasoning vs pattern matching. Extremely hard to game because each task requires novel abstraction. Low scores across all models confirm its validity.',
            scores: { 'DeepSeek R1': 6.0, 'Claude 3.5 Sonnet': 21.0, 'GPT-4o': 5.0, 'Gemini 1.5 Pro': 8.0, 'Llama 3.3 70B': 2.0 }
        },
        {
            slug: 'swe-bench-verified', name: 'SWE-bench Verified', subtitle: 'Real-World Software Engineering', year: 2023,
            trust: 3.2, gamingRisk: 54,
            tags: ['coding', 'debugging'],
            paperUrl: 'https://arxiv.org/abs/2310.06770',
            repoUrl: 'https://github.com/princeton-nlp/SWE-bench',
            description: '500 human-verified software engineering tasks sourced from real GitHub issues across popular Python repos. Models must understand codebases, diagnose bugs, and generate working patches.',
            communityVerdict: 'Important real-world benchmark but high gaming risk due to training data contamination — many source repos are in LLM training sets. The "Verified" subset helps but scaffolding differences across evaluations make comparison difficult.',
            scores: { 'DeepSeek R1': 49.2, 'Claude 3.5 Sonnet': 50.8, 'GPT-4o': 38.8, 'Gemini 1.5 Pro': 36.2, 'Llama 3.3 70B': 26.5 }
        },
        {
            slug: 'livecodebench', name: 'LiveCodeBench', subtitle: 'Contamination-Free Coding Eval', year: 2024,
            trust: 3.8, gamingRisk: 31,
            tags: ['coding', 'algorithms'],
            paperUrl: 'https://arxiv.org/abs/2403.07974',
            repoUrl: 'https://github.com/LiveCodeBench/LiveCodeBench',
            description: 'Continuously updated coding benchmark using problems from competitive programming contests published after model training cutoffs. Eliminates data contamination by design.',
            communityVerdict: 'Clever approach to contamination. The rolling time window is its biggest strength. However, competitive programming measures a narrow slice of coding ability, and difficulty calibration varies across contest sources.',
            scores: { 'DeepSeek R1': 65.9, 'Claude 3.5 Sonnet': 51.3, 'GPT-4o': 45.2, 'Gemini 1.5 Pro': 43.8, 'Llama 3.3 70B': 33.1 }
        },
        {
            slug: 'chatbot-arena', name: 'Chatbot Arena', subtitle: 'Human Preference ELO Ratings', year: 2023,
            trust: 3.6, gamingRisk: 42,
            tags: ['general-helpfulness'],
            paperUrl: 'https://arxiv.org/abs/2403.04132',
            repoUrl: 'https://github.com/lm-sys/FastChat',
            description: 'Large-scale crowdsourced platform where users chat with two anonymous models and vote for the better response. Produces ELO-style rankings from hundreds of thousands of human preference comparisons.',
            communityVerdict: 'The closest thing to a "real world" benchmark, but susceptible to style over substance bias — verbose, confident responses often win regardless of accuracy. Category-specific arenas help but demographic bias in voters remains.',
            scores: { 'DeepSeek R1': 1358, 'Claude 3.5 Sonnet': 1271, 'GPT-4o': 1290, 'Gemini 1.5 Pro': 1267, 'Llama 3.3 70B': 1183 }
        },
        {
            slug: 'mmlu', name: 'MMLU', subtitle: 'Massive Multitask Language Understanding', year: 2020,
            trust: 1.8, gamingRisk: 91,
            tags: ['knowledge-breadth'],
            paperUrl: 'https://arxiv.org/abs/2009.03300',
            repoUrl: 'https://github.com/hendrycks/test',
            description: '14,042 multiple-choice questions across 57 academic subjects from STEM to humanities. Originally designed to measure breadth of knowledge and reasoning across diverse domains.',
            communityVerdict: 'Once the standard benchmark, now considered deeply compromised. Massive contamination in training data, inconsistent question quality, and ceiling effects make differences between top models meaningless. Scores above 85% reflect memorization more than understanding.',
            scores: { 'DeepSeek R1': 90.8, 'Claude 3.5 Sonnet': 88.7, 'GPT-4o': 88.7, 'Gemini 1.5 Pro': 85.9, 'Llama 3.3 70B': 86.0 }
        },
        {
            slug: 'humaneval', name: 'HumanEval', subtitle: 'Python Code Generation', year: 2021,
            trust: 1.2, gamingRisk: 96,
            tags: ['coding'],
            paperUrl: 'https://arxiv.org/abs/2107.03374',
            repoUrl: 'https://github.com/openai/human-eval',
            description: '164 hand-written Python programming problems with function signatures and docstrings. Models generate function bodies which are tested against hidden unit tests.',
            communityVerdict: 'Essentially useless as a benchmark in 2024+. Completely saturated, thoroughly contaminated, and trivially small. Every major model scores 90%+, making it impossible to differentiate capabilities. A historical artifact at this point.',
            scores: { 'DeepSeek R1': 96.3, 'Claude 3.5 Sonnet': 93.7, 'GPT-4o': 90.2, 'Gemini 1.5 Pro': 91.5, 'Llama 3.3 70B': 88.4 }
        }
    ],
    models: ['DeepSeek R1', 'Claude 3.5 Sonnet', 'GPT-4o', 'Gemini 1.5 Pro', 'Llama 3.3 70B']
};

/* ── Alpine.js App ── */
function supraBench() {
    return {
        view: 'explorer',
        previousView: 'explorer',
        benchmarks: [],
        activeTags: [],
        allTags: [],
        indexSort: { key: 'trust', dir: -1 },
        currentBenchmark: null,

        // Submit state
        submitStep: 1,
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
            modelScores: [{ model: '', score: '' }]
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
            this.previousView = this.view;
            this.view = 'detail';
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

        /* ── Reality Score: trust-weighted model ranking ── */
        get rankedModels() {
            const fb = this.filteredBenchmarks;
            if (!fb.length) return [];
            const modelNames = new Set();
            fb.forEach(b => Object.keys(b.scores || {}).forEach(m => modelNames.add(m)));
            return [...modelNames].map(name => {
                let weightedSum = 0, weightTotal = 0;
                fb.forEach(b => {
                    if (b.scores?.[name] !== undefined) {
                        const w = b.trust;
                        let score = b.scores[name];
                        // Normalize ELO-based benchmarks to ~0-100 scale
                        if (b.slug === 'chatbot-arena') score = (score - 1000) / 5;
                        weightedSum += score * w;
                        weightTotal += w;
                    }
                });
                return { name, realityScore: weightTotal ? weightedSum / weightTotal : 0 };
            }).sort((a, b) => b.realityScore - a.realityScore);
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
            else { this.indexSort.key = key; this.indexSort.dir = key === 'trust' ? -1 : 1; }
        },

        /* ── Helpers ── */
        trustColor(t) {
            if (t >= 4) return '#44ff88';
            if (t >= 3) return '#E5FE40';
            if (t >= 2) return '#ffaa44';
            return '#ff4444';
        },

        riskClass(r) {
            if (r <= 25) return 'risk-low';
            if (r <= 60) return 'risk-med';
            return 'risk-high';
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

        resetForm() {
            this.form = {
                name: '', subtitle: '', year: '', paperUrl: '', repoUrl: '',
                description: '', communityVerdict: '',
                capabilityTags: [], useCaseTags: [],
                gamingRisk: 50,
                modelScores: [{ model: '', score: '' }]
            };
            this.submitStep = 2;
            this.submitError = '';
            this.prUrl = '';
        }
    };
}
