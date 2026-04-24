(function () {
  "use strict";

  const KEY = "sb_notice_v1";
  const el = document.getElementById("sb-cookie");
  if (!el) return;

  try {
    if (!localStorage.getItem(KEY)) el.hidden = false;
  } catch (e) {
    return;
  }

  function dismiss() {
    try { localStorage.setItem(KEY, "1"); } catch (e) {}
    el.hidden = true;
  }

  for (const btn of document.querySelectorAll("[data-sb-dismiss-cookie]")) {
    btn.addEventListener("click", dismiss);
  }
})();

