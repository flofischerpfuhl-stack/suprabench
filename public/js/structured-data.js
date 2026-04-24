(function () {
  "use strict";

  const data = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "SupraBench",
    url: "https://suprabench.com/",
    description: "Community-driven AI model rankings based on benchmark trustworthiness.",
    publisher: {
      "@type": "Organization",
      name: "SupraBench",
      logo: {
        "@type": "ImageObject",
        url: "https://suprabench.com/img/icon-512.png",
      },
    },
  };

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
})();

