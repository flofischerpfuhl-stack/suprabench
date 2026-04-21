# Stripe product images

Square PNGs used as the product-image upload in the Stripe dashboard
for the three self-serve API tiers. Kept in the repo for transparency
(anyone can see exactly what the Stripe product listings show) and so
they survive if we rotate the Stripe account.

- [`starter.png`](starter.png)      — API Starter
- [`pro.png`](pro.png)              — API Pro
- [`enterprise.png`](enterprise.png) — API Enterprise

The fourth tier (**Enterprise+**) is manual invoicing and has no
Stripe Product entry, so no icon is needed.

Upload flow: Stripe dashboard → Products → *Create product* →
*Add image* → pick the file here. Stripe accepts JPEG / PNG / WEBP
up to 2 MB; each of these is ~700 KB PNG, 1024×576.
