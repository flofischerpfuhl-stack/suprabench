// ════════════════════════════════════════════════════════════
// SupraBench docs interactivity.
//
// Three jobs:
//   1. Multi-language code blocks: clicking a language tab swaps the
//      visible <pre> within the same .code-block.
//   2. Copy-to-clipboard: every code pane has a "Copy" button.
//   3. Active-section indicator in the right-hand TOC, using
//      IntersectionObserver to track which <h2>/<h3> is currently
//      onscreen.
//
// Standalone — no Alpine, no framework. The docs site has to load
// fast for developers triaging at 2am.
// ════════════════════════════════════════════════════════════

(function () {
  if (typeof document === "undefined") return;

  // ── 1. Code-language tabs ──────────────────────────────────
  // Each .code-block contains:
  //   .code-tabs > .code-tab[data-lang="curl"|"python"|"js"|...]
  //   .code-pane[data-lang="curl"|...]
  // Tabs and panes are wired by data-lang. First tab/pane is
  // expected to be marked .active on render.
  document.querySelectorAll(".code-block").forEach((block) => {
    const tabs  = block.querySelectorAll(".code-tab");
    const panes = block.querySelectorAll(".code-pane");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const lang = tab.dataset.lang;
        tabs.forEach((t) => t.classList.toggle("active", t.dataset.lang === lang));
        panes.forEach((p) => p.classList.toggle("active", p.dataset.lang === lang));
        // Persist last-selected language across pages so users who
        // pick "python" once see python in every example.
        try { localStorage.setItem("sb_docs_lang", lang); } catch {}
      });
    });
  });

  // Restore preferred language on load.
  try {
    const saved = localStorage.getItem("sb_docs_lang");
    if (saved) {
      document.querySelectorAll(".code-block").forEach((block) => {
        const tab = block.querySelector(`.code-tab[data-lang="${saved}"]`);
        if (tab) tab.click();
      });
    }
  } catch {}

  // ── 2. Copy buttons ───────────────────────────────────────
  document.querySelectorAll(".code-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pane = btn.closest(".code-pane");
      if (!pane) return;
      const code = pane.querySelector("pre")?.innerText ?? "";
      try {
        await navigator.clipboard.writeText(code);
        const orig = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1400);
      } catch {
        btn.textContent = "Press ⌘C";
        // Fallback: select text so the user can copy manually.
        const range = document.createRange();
        range.selectNodeContents(pane.querySelector("pre"));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });

  // ── 3. Active-section TOC ─────────────────────────────────
  // We highlight the link in .docs-toc that matches the topmost
  // visible heading. IntersectionObserver gives us a near-free,
  // scroll-event-free implementation.
  const tocLinks = document.querySelectorAll(".docs-toc a[href^='#']");
  if (tocLinks.length > 0) {
    const linkByHref = new Map();
    tocLinks.forEach((a) => linkByHref.set(a.getAttribute("href"), a));

    const headings = Array.from(document.querySelectorAll(
      ".docs-content h2[id], .docs-content h3[id]"
    ));
    const visible = new Set();

    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else                  visible.delete(e.target.id);
      }
      // Pick the first heading (in document order) that's currently visible.
      const firstVisible = headings.find((h) => visible.has(h.id));
      tocLinks.forEach((a) => a.classList.remove("active"));
      if (firstVisible) {
        const link = linkByHref.get(`#${firstVisible.id}`);
        if (link) link.classList.add("active");
      }
    }, {
      // Trigger when heading enters the top 20% of the viewport.
      rootMargin: "-80px 0px -75% 0px",
      threshold: 0,
    });

    headings.forEach((h) => observer.observe(h));
  }

  // ── 4. Mobile nav drawer ──────────────────────────────────
  const burger = document.querySelector(".docs-topbar__hamburger");
  const topnav = document.querySelector(".docs-topbar__nav");
  if (burger && topnav) {
    burger.addEventListener("click", () => topnav.classList.toggle("is-open"));
  }
  // Sidebar collapse on mobile (the long endpoint nav can drown the page).
  const navToggle = document.querySelector(".docs-nav-toggle");
  const navCollapsible = document.querySelector(".docs-nav-collapsible");
  if (navToggle && navCollapsible) {
    navToggle.addEventListener("click", () => navCollapsible.classList.toggle("is-open"));
  }
})();
