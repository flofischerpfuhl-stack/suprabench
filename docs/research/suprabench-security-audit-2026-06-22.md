# SupraBench Security, Functionality and Capacity Audit, 2026-06-22

Status: keine Datenbank-Writes. Repo-Fixes wurden lokal vorgenommen und verifiziert.

## Executive Summary

- `npm audit --omit=dev` im Root: 0 Vulnerabilities.
- `npm audit` in `tests/convex`: 0 Vulnerabilities.
- `npm test`: 104/104 Tests gruen.
- `npm run check:tiers`: gruen.
- Keine getrackten `.env`, OAuth-Client-Secret-JSONs, PEMs oder `.dev.vars` gefunden.
- Lokales Risiko bleibt: `.env.local` und `client_secret_*.json` liegen ignoriert im Repo-Root. Die OAuth-Datei enthaelt ein `web.client_secret`; sie ist nicht getrackt, sollte aber aus dem Arbeitsbaum raus und rotiert werden, falls sie je synchronisiert/geteilt/gesichert wurde.

## Behobene Findings

| Severity | Finding | Fix |
|---|---|---|
| High | Authenticated API responses used `Cache-Control: public`, although quota/rate-limit accounting happens only when Convex receives the request. | `/v1/*` JSON responses now use `Cache-Control: private, max-age=...`; docs/tests updated. |
| High | Paid Stripe API keys could become fail-open once Stripe is activated because created keys did not store subscription linkage and auth only rejected inactive status when a status existed. | `createKey` now stores `stripeSubscriptionId` and `stripeSubscriptionStatus`; paid-tier auth fails closed when linkage/status is missing or not `active|trialing`; regression tests added. |
| Medium | API logs stored raw IPs while schema/comment promised hashed IPs. | `clientIpHash()` hashes IPs with SHA-256 before `apiRequestLog` insert. |
| Medium/High | Root and test dependency audits flagged `ws`, `convex`, `vitest`/`vite` advisories. | Upgraded `convex`, `convex-test`, `vitest`, `@edge-runtime/vm`, `typescript`; added `overrides.ws=8.21.0` in root and tests package. |

Relevant files:

- [convex/api.ts](../../convex/api.ts)
- [tests/convex/auth.test.ts](../../tests/convex/auth.test.ts)
- [tests/convex/keys-and-partners.test.ts](../../tests/convex/keys-and-partners.test.ts)
- [tests/convex/package.json](../../tests/convex/package.json)
- [package.json](../../package.json)

## Remaining Risks Before Public Promotion

| Severity | Area | Risk | Recommendation |
|---|---|---|---|
| High local hygiene | Secrets | Ignored `client_secret_*.json` with Google OAuth secret is still in repo root. Not tracked, but easy to accidentally sync/back up. | Move outside repo; rotate if it may have left this machine. Keep `.gitignore` rules. |
| Medium | Community abuse | Vote/rating/submission limits are account-based. Coordinated new accounts can still manipulate low-engagement entities. | Add IP/device/global throttles, new-account dampening, moderation queue or alerting for bursts. |
| Medium | Admin scope | Any admin can grant high API tiers; only admin promotion is primary-admin-only. | Split roles or make tier grants/key revokes primary-admin-only. |
| Medium | Frontend XSS impact | Auth tokens live in `localStorage`; CSP still allows `unsafe-eval` and third-party script CDNs. No unsafe user HTML rendering found, but impact would be high if XSS appears later. | Prefer self-hosted scripts/SRI, remove `unsafe-eval` if Alpine/Convex setup allows, consider shorter-lived tokens or HttpOnly cookie auth. |
| Medium | Public query cost | Some anonymous Convex read paths still do broad collection/filter work. | Cap filters, paginate aggressively, precompute hot filtered views, add edge/origin throttles. |
| Low | Slugs | New model/bench names with no ASCII alphanumerics can generate empty slugs. | Reject empty generated slugs or generate fallback IDs. |
| Low | Export DTO | `/v1/export.json` returns raw Convex-derived documents with internal IDs/cache fields. | Return explicit public DTOs. |
| Low | Log retention | `apiRequestLog` cleanup deletes 500 old rows/hour. | Increase cleanup throughput before large API usage. |

## Capacity Assessment

Convex Free is not enough for "many users" if traffic becomes real. Official Convex limits as of 2026-06-22 include Free hard caps of 0.5 GB database storage, 1 GB/month database I/O, 1,000,000 function calls/month, 20 GB-hours/month action compute, S16 deployment class, 1,000 concurrent sessions, 16 concurrent queries, 16 concurrent mutations, and 4 MiB mutation write throughput. Sources:

- https://docs.convex.dev/production/state/limits
- https://www.convex.dev/pricing

The repo already mitigates the main hot path by denormalizing rankings and mirroring score rebuild input to Cloudflare D1. That helps a lot, but it does not remove all Convex pressure: every authenticated API request still does key lookup, rate-limit mutation, quota mutation, data query and async request logging.

Cloudflare D1 Free is useful for the score mirror but also capped. Official D1 Free limits include 5M rows read/day, 100k rows written/day, 5 GB account storage, and 500 MB maximum database size on Free. If daily limits are exceeded, D1 returns errors until reset. Sources:

- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/

Bulk score imports should not overload Convex/D1 if done through an admin/import path in chunks. The existing D1 mirror chunks `/scores/bulk` at 100 rows. For the planned DeepSWE/SkateBench/refresh batch size, that is small. Avoid using normal public submission mutations for thousands of rows; use an idempotent admin import, mirror in chunks, then run one final global rebuild.

## Verification Commands

```bash
npm test
npm audit --omit=dev --json
(cd tests/convex && npm audit --json)
npm run check:tiers
git ls-files -- .env.local 'client_secret_*.json'
git status --ignored --short -- .env.local 'client_secret_*.json'
```

Final verification output summary:

- Tests: 9 files, 104 tests passed.
- Root audit: 0 total vulnerabilities.
- `tests/convex` audit: 0 total vulnerabilities.
- Tier consistency: OK.

## Git History / Secrets

Local/subagent scans found no committed `.env`, Google OAuth `client_secret*.json`, PEM/private-key files, `.dev.vars`, `.npmrc`, or known Stripe/OpenAI/GitHub/Google API key literals. Pattern searches did match docs/placeholders and historical comments, not exposed live secrets.

Treat `wrangler.toml` database IDs and route names as deployment metadata, not secrets.
