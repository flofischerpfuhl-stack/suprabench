/* ═══════════════════════════════════════════
   SUPRABENCH — GitHub OAuth PKCE + API
   ═══════════════════════════════════════════ */

const CONFIG = {
    owner: 'flofischerpfuhl-stack',               // ← GitHub username
    repo: 'suprabench',
    clientId: 'YOUR_GITHUB_CLIENT_ID', // ← from GitHub OAuth App settings
    redirectUri: window.location.origin + window.location.pathname,
    dataUrl: '/data/generated.json'
};

const GitHubAPI = {

    /* ── PKCE helpers ── */
    async generatePKCE() {
        const arr = new Uint8Array(32);
        crypto.getRandomValues(arr);
        const verifier = btoa(String.fromCharCode(...arr))
            .replace(/[^a-zA-Z0-9]/g, '')
            .substring(0, 43);
        const encoded = new TextEncoder().encode(verifier);
        const digest = await crypto.subtle.digest('SHA-256', encoded);
        const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        return { verifier, challenge };
    },

    /* ── OAuth flow ── */
    async startLogin() {
        const { verifier, challenge } = await this.generatePKCE();
        sessionStorage.setItem('pkce_verifier', verifier);
        const state = crypto.randomUUID();
        sessionStorage.setItem('oauth_state', state);
        const params = new URLSearchParams({
            client_id: CONFIG.clientId,
            redirect_uri: CONFIG.redirectUri,
            scope: 'repo',
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256'
        });
        window.location.href = 'https://github.com/login/oauth/authorize?' + params;
    },

    async exchangeCode(code) {
        const verifier = sessionStorage.getItem('pkce_verifier');
        const resp = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                client_id: CONFIG.clientId,
                code,
                code_verifier: verifier,
                redirect_uri: CONFIG.redirectUri,
                grant_type: 'authorization_code'
            })
        });
        const data = await resp.json();
        sessionStorage.removeItem('pkce_verifier');
        sessionStorage.removeItem('oauth_state');
        return data.access_token;
    },

    /* ── API helpers ── */
    async getUser(token) {
        const r = await fetch('https://api.github.com/user', {
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.v3+json' }
        });
        return r.json();
    },

    async api(path, token, opts = {}) {
        const r = await fetch('https://api.github.com' + path, {
            ...opts,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                ...(opts.headers || {})
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
    },

    /* ── Create PR with benchmark .md file ── */
    async createPR(token, benchmark) {
        const slug = benchmark.name.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
        const ts = Date.now();
        const branchName = `benchmarks/add-${slug}-${ts}`;
        const repo = `${CONFIG.owner}/${CONFIG.repo}`;

        // 1. Get main branch SHA
        const ref = await this.api(`/repos/${repo}/git/ref/heads/main`, token);
        const mainSha = ref.object.sha;

        // 2. Create branch
        await this.api(`/repos/${repo}/git/refs`, token, {
            method: 'POST',
            body: { ref: `refs/heads/${branchName}`, sha: mainSha }
        });

        // 3. Build YAML frontmatter + markdown body
        const frontmatter = [
            '---',
            `name: "${benchmark.name}"`,
            benchmark.subtitle ? `subtitle: "${benchmark.subtitle}"` : '',
            benchmark.year ? `year: ${benchmark.year}` : '',
            `trust: ${benchmark.trust || 3.0}`,
            `gaming_risk: ${benchmark.gamingRisk}`,
            benchmark.paperUrl ? `paper_url: "${benchmark.paperUrl}"` : '',
            benchmark.repoUrl ? `repo_url: "${benchmark.repoUrl}"` : '',
            `capability_tags: [${(benchmark.capabilityTags || []).map(t => '"' + t + '"').join(', ')}]`,
            `use_case_tags: [${(benchmark.useCaseTags || []).map(t => '"' + t + '"').join(', ')}]`,
            '---'
        ].filter(Boolean).join('\n');

        let body = `\n# ${benchmark.name}\n\n${benchmark.description}\n`;
        if (benchmark.communityVerdict) {
            body += `\n## Community Verdict\n\n${benchmark.communityVerdict}\n`;
        }
        if (benchmark.modelScores?.length) {
            body += '\n## Model Scores\n\n| Model | Score |\n|-------|-------|\n';
            benchmark.modelScores.filter(m => m.model).forEach(m => {
                body += `| ${m.model} | ${m.score} |\n`;
            });
        }

        const content = btoa(unescape(encodeURIComponent(frontmatter + '\n' + body)));

        // 4. Create file in branch
        await this.api(`/repos/${repo}/contents/benchmarks/${slug}.md`, token, {
            method: 'PUT',
            body: { message: `Add benchmark: ${benchmark.name}`, content, branch: branchName }
        });

        // 5. Open PR
        const pr = await this.api(`/repos/${repo}/pulls`, token, {
            method: 'POST',
            body: {
                title: `Add benchmark: ${benchmark.name}`,
                head: branchName,
                base: 'main',
                body: [
                    '## New Benchmark Submission',
                    '',
                    `**Name:** ${benchmark.name}`,
                    `**Gaming Risk:** ${benchmark.gamingRisk}%`,
                    `**Tags:** ${[...(benchmark.capabilityTags || []), ...(benchmark.useCaseTags || [])].join(', ')}`,
                    '',
                    benchmark.description || ''
                ].join('\n')
            }
        });

        return pr.html_url;
    }
};
