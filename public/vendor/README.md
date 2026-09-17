# Self-hosted third-party libraries

These files are unmodified copies of the published npm artefacts. They are
served from our own origin so that visitors' browsers do not have to contact
public CDNs (jsDelivr, unpkg). Each file was verified byte-for-byte (SHA-384)
against the CDN copy on 2026-09-17.

| Library | Version | Licence | Files | Source |
|---|---|---|---|---|
| Alpine.js | 3.13.3 | MIT (`alpinejs/LICENSE.md`) | `alpinejs/cdn.min.js` | https://cdn.jsdelivr.net/npm/alpinejs@3.13.3/dist/cdn.min.js |
| KaTeX | 0.16.11 | MIT (`katex/LICENSE`); bundled KaTeX fonts: SIL OFL 1.1 | `katex/katex.min.js`, `katex/katex.min.css`, `katex/contrib/auto-render.min.js`, `katex/fonts/*` (60 files) | https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/ |
| Convex browser bundle | 1.35.1 | Apache-2.0 (`convex/LICENSE`) | `convex/browser.bundle.js` | https://unpkg.com/convex@1.35.1/dist/browser.bundle.js |

## Integrity (SHA-384, base64)

```
alpinejs/cdn.min.js               sha384-Rpe/8orFUm5Q1GplYBHxbuA8Az8O8C5sAoOsdbRWkqPjKFaxPgGZipj4zeHL7lxX
katex/katex.min.js                sha384-7zkQWkzuo3B5mTepMUcHkMB5jZaolc2xDwL6VFqjFALcbeS9Ggm/Yr2r3Dy4lfFg
katex/katex.min.css               sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+
katex/contrib/auto-render.min.js  sha384-43gviWU0YVjaDtb/GhzOouOXtZMP/7XUzwPTstBeZFe/+rCMvRwr4yROQP43s0Xk
convex/browser.bundle.js          sha384-WBH9GzZvyXz2qS7FA3/Fp2Hqk0yFExnlGhQVyQ8Ji3rvH6QE9wcxHPMaLcu7YpBA
```

The KaTeX hashes are identical to the SRI values published by KaTeX for 0.16.11.

## Upgrading

1. Download the new version's files from the source URLs above into the same paths
   (including every `fonts/*` file referenced by `katex.min.css`).
2. Update the table and hashes in this file.
3. Bump the `?v=<version>` query strings (and `integrity` attributes) in `public/index.html`.
