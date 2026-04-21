#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// Tier consistency linter
//
// Source of truth: convex/tiers.ts
// This script greps every doc / HTML / markdown file that mentions
// API tier numbers and flags anything that doesn't match TIERS.
//
// Run manually:  node scripts/check-tier-consistency.mjs
// Or via npm:    npm run check:tiers
// Exits non-zero on drift so CI can wire it into the pre-merge gate.
// ════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. Parse TIERS out of convex/tiers.ts ───────────────────
//
// Tiny regex-based parser so we don't have to spin up tsc just for a
// linter. Matches "  starter:  { priceUsd: 5, monthlyQuota: 10_000, ... }"
// and accepts numeric literals with `_` separators or `null`.
const tiersSrc = readFileSync(resolve(ROOT, "convex/tiers.ts"), "utf8");

function parseTiers(src) {
  const block = src.match(/export const TIERS = \{([\s\S]*?)\n\} as const;/);
  if (!block) throw new Error("could not find TIERS block in convex/tiers.ts");
  const tiers = {};
  const tierRe = /(\w+):\s*\{([^}]*)\}/g;
  for (const m of block[1].matchAll(tierRe)) {
    const [, name, body] = m;
    const cfg = {};
    for (const f of body.matchAll(/(\w+):\s*([^,\n]+)/g)) {
      const [, k, raw] = f;
      const trimmed = raw.trim().replace(/,$/, "").trim();
      if (trimmed === "null") cfg[k] = null;
      else if (trimmed === "true") cfg[k] = true;
      else if (trimmed === "false") cfg[k] = false;
      else if (/^[\d_]+$/.test(trimmed)) cfg[k] = Number(trimmed.replace(/_/g, ""));
      else cfg[k] = trimmed;
    }
    tiers[name] = cfg;
  }
  return tiers;
}

const TIERS = parseTiers(tiersSrc);

// ── 2. Build the set of all numbers that ARE allowed to appear ──
//
// A user can write "10_000", "10000", "10 000", "10,000", "10k" — so
// we generate every common formatting variant and treat any of them
// as a valid mention of that quota.
function variants(n) {
  if (n === null) return [];
  const s = String(n);
  const withSpaces = s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const withCommas = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const withUnders = s.replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  const out = new Set([s, withSpaces, withCommas, withUnders]);
  if (n >= 1000 && n % 1000 === 0)   out.add(`${n / 1000}k`).add(`${n / 1000} k`);
  if (n >= 1_000_000 && n % 1_000_000 === 0) out.add(`${n / 1_000_000}M`).add(`${n / 1_000_000} M`);
  return [...out];
}

const allowed = {
  prices:   new Set(),
  quotas:   new Set(),
  rpm:      new Set(),
  maxKeys:  new Set(),
};
for (const cfg of Object.values(TIERS)) {
  for (const v of variants(cfg.priceUsd))     allowed.prices.add(v);
  for (const v of variants(cfg.monthlyQuota)) allowed.quotas.add(v);
  for (const v of variants(cfg.rpmLimit))     allowed.rpm.add(v);
  for (const v of variants(cfg.maxKeys))      allowed.maxKeys.add(v);
}

// ── 3. Patterns to look for, per category ───────────────────
//
// Each entry is { label, regex, category }. The regex must capture
// the number (or number-with-spacing) in group 1.
const NUM = "[\\d][\\d _,]*[\\d]|\\d";        // matches "10", "10_000", "10 000", "1,000,000"
const PATTERNS = [
  // "$5", "$ 5", "$5 / month", "$ 5/mo"
  { label: "price",   category: "prices",  re: new RegExp(`\\$\\s*(${NUM})\\b`, "g") },
  // "5 €", "€5", "EUR 5"
  { label: "price",   category: "prices",  re: new RegExp(`(?:€|EUR\\s+)\\s*(${NUM})\\b`, "g") },
  // "10 000 / month", "10,000 requests / month", "100k req/month"
  { label: "quota",   category: "quotas",  re: new RegExp(`(${NUM}|\\d+k|\\d+M)\\s*(?:requests?|req)?\\s*(?:/|per)\\s*month`, "gi") },
  // "10 000 req-bucket" forms inside tables: pure number column
  // (handled by the prose match above for most docs)
  // "60 req/min", "60 / min", "60 req / min", "300 rpm"
  { label: "rpm",     category: "rpm",     re: new RegExp(`(${NUM})\\s*(?:requests?|req)?\\s*(?:/|per)\\s*min\\b`, "gi") },
  { label: "rpm",     category: "rpm",     re: new RegExp(`(${NUM})\\s*rpm\\b`, "gi") },
];

// ── 4. Files to scan ─────────────────────────────────────────
const FILES = [
  "docs/api-roadmap.md",
  "public/index.html",
  "public/docs/api/index.html",
  "public/docs/api/authentication.html",
  "public/docs/api/rate-limits.html",
  "public/docs/api/quickstart.html",
  "public/docs/api/changelog.html",
  "public/docs/api/errors.html",
  "public/docs/api/pagination.html",
  "public/docs/api/versioning.html",
  "public/docs/api/reference/models.html",
  "public/docs/api/reference/benches.html",
  "public/docs/api/reference/best.html",
  "public/docs/api/reference/tags.html",
  "public/docs/api/reference/export.html",
  "public/legal/terms.html",
  "convex/schema.ts",
  "convex/api.future.ts",
  "convex/stripe.future.ts",
];

// Numbers that are intentionally not tier numbers (example IDs,
// timestamps, scale ranges, etc.). Keep this list short and grep-able.
const IGNORE_LINE = [
  /\d{10,}/,                      // unix timestamps, big example IDs
  /1745000000000/,                // example accessedAt
  /1744750000000/,
  /scaleM(in|ax)/i,               // bench scale fields, not API
  /Reading time/i,
  /Last updated/i,
  /viewport/i,
  /v=2026\d{4,}/,                 // cache-bust query strings
  /favicon|apple-touch/i,
  /9 800.*\/.*10 000/,            // example arithmetic showing pro-rate
  /90 200/,                       // result of the same example
  /5\s?000\s?\+/,                 // "5 000 + models" in pagination is dataset size, not a tier
  /10\s?000\s?rows/,              // pagination's threshold-for-paging note
];

// ── 5. Scan ─────────────────────────────────────────────────
let drift = 0;
const allowedAll = new Set([
  ...allowed.prices, ...allowed.quotas, ...allowed.rpm, ...allowed.maxKeys,
]);

function normalize(s) { return s.replace(/[\s,_]/g, ""); }
const allowedNumeric = new Set([...allowedAll].map(normalize));
// Filter out numbers that show up in tier rows but aren't tier values:
// year-shaped 4-digit numbers (timestamps, dates) and zeros. We do
// NOT exempt single-digit numbers — those are exactly the prices
// ("$5") and key counts ("1") we need to validate.
function isAmbiguous(n) {
  return /^(19|20)\d{2}$/.test(n) || n === "0" || n === "00";
}

// Row counts as a "tier row" only when a tier name appears as the
// row LABEL (first cell), not buried in description prose.
//   markdown:  "| **Starter** | $5 | …"   or   "| Starter | $5 | …"
//   html:      "<tr><td>Starter</td><td>$5</td>…"  (also <strong>/<b> wrappers)
// "Enterprise+" with the "+" is matched via `Enterprise\+?` so plain
// "Enterprise" labels still count too.
const MD_TIER_ROW_RE   = /^\s*\|\s*(?:\*\*)?(Starter|Pro|Enterprise\+?)(?:\*\*)?\s*\|/i;
const HTML_TIER_ROW_RE = /<tr[^>]*>\s*<td[^>]*>\s*(?:<(?:strong|b|span[^>]*)>\s*)?(Starter|Pro|Enterprise\+?)\b/i;
// Match any number-shaped token: "$5", "5", "10 000", "10_000", "10,000", "10k", "1M".
const NUMBER_TOKEN_RE = /\$?\s*(\d[\d _,]*\d|\d)(?:\s?[kKmM]\b)?/g;

function report(rel, lineNo, raw, line, hint) {
  drift++;
  console.error(
    `\x1b[31mdrift:\x1b[0m ${rel}:${lineNo}  ${JSON.stringify(raw)}  ${hint}\n` +
    `  | ${line.trim()}`
  );
}

function checkTierRow(rel, lineNo, line) {
  // A "tier row" is a markdown table row (starts with `|`) or an HTML
  // <tr> that contains a tier name. Every standalone number on that
  // row must be in the union allowed set.
  for (const m of line.matchAll(NUMBER_TOKEN_RE)) {
    const tok = m[0].trim();
    const num = m[1].trim();
    const norm = normalize(num);
    if (isAmbiguous(num)) continue;
    if (allowedNumeric.has(norm)) continue;
    // Tolerate "k"/"M" suffix forms by also checking the expanded number.
    const expanded = /[kK]$/.test(tok) ? Number(norm) * 1_000
                   : /[mM]$/.test(tok) ? Number(norm) * 1_000_000
                   : Number(norm);
    if (allowedNumeric.has(String(expanded))) continue;
    report(rel, lineNo, tok, line, "in tier row but not in TIERS");
  }
}

for (const rel of FILES) {
  const path = resolve(ROOT, rel);
  let src;
  try { src = readFileSync(path, "utf8"); }
  catch { continue; } // file may not exist on a partial checkout

  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (IGNORE_LINE.some(re => re.test(line))) continue;

    // Targeted prose patterns ($5/month, 60 req/min, …)
    for (const { label, category, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const raw = m[1].trim();
        const norm = normalize(raw);
        const okExact   = allowed[category].has(raw);
        const okNumeric = allowedNumeric.has(norm);
        if (!okExact && !okNumeric) {
          report(rel, i + 1, raw, line,
            `${label} not in TIERS.${category} (${[...allowed[category]].join(", ") || "∅"})`);
        }
      }
    }

    // Table-row sweep: only rows where a tier name is the row LABEL
    // (first cell) get fully validated — this is where pricing tables
    // live. Rows that merely *mention* a tier in description text
    // (e.g. "Starter tier — bulk export is Pro+ only") are skipped.
    if (MD_TIER_ROW_RE.test(line) || HTML_TIER_ROW_RE.test(line)) {
      checkTierRow(rel, i + 1, line);
    }
  }
}

if (drift > 0) {
  console.error(`\n\x1b[31m✗ ${drift} drift(s)\x1b[0m — fix the file(s) above or update convex/tiers.ts.`);
  process.exit(1);
} else {
  console.log("\x1b[32m✓ tier consistency OK\x1b[0m — all docs match convex/tiers.ts");
}
