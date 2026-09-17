// Reload as soon as the browser reports the network is back.
// Lives in its own file because the CSP forbids inline scripts.
window.addEventListener("online", () => location.reload());
