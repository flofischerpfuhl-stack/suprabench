// ════════════════════════════════════════════════════════════
// Stripe billing — PLACEHOLDER, NOT WIRED UP.
//
// Pairs with convex/api.future.ts. The Stripe layer's job is:
//   1. Get a logged-in user to a Checkout page for a given tier.
//   2. Verify the resulting webhook from Stripe (HMAC-SHA256 sig check).
//   3. Mirror the resulting subscription into our `stripeSubscriptions`
//      table so the rest of the app (api:createKey, the dashboard,
//      authenticate()) can query it locally and never have to call
//      Stripe at request-time.
//   4. Cascade subscription state onto API keys so a cancelled sub
//      stops working immediately (next request → 402).
//
// ──────────────────────────────────────────────────────────────
// HOW TO ACTIVATE: see ACTIVATION.md in the repo root for the
// step-by-step runbook. Short summary: Products + Prices already
// exist in Stripe (PRICE_IDS below are live). What's missing before
// users can actually pay is (a) uncommenting the code block, (b)
// uncommenting the stripe* tables in schema.ts, (c) registering the
// /stripe/webhook endpoint in Stripe and setting STRIPE_WEBHOOK_SECRET
// + STRIPE_SECRET_KEY on prod env, (d) uncommenting the
// subscription UI in public/index.html. Three independent locks.
//
// Why no node-stripe SDK?
//   Convex's runtime doesn't ship a Node environment for HTTP actions
//   — it's a V8 isolate with `fetch` and `crypto.subtle`. The Stripe
//   SDK *does* ship a fetch backend, but bundling it just for two API
//   calls (checkout.sessions.create + signature verify) is heavier
//   than calling Stripe's REST API directly. So we use raw fetch.
// ════════════════════════════════════════════════════════════

export {};

/* ════════════════════════════════════════════════════════════

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { httpRouter } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { TIERS, type Tier } from "./tiers";

// ── Configuration ──────────────────────────────────────────

// Map our tier names → Stripe Price IDs. Keep in sync with the
// Stripe dashboard. Use *recurring* prices, not one-time.
// enterprise_plus is excluded — that tier is manual/contract and
// never hits self-serve checkout.
// Live-mode Price IDs (created 2026-04). These are NOT secrets — Stripe
// embeds them in every Checkout URL and they're safe to ship in public
// source. The *Product* these belong to lives in our Stripe account;
// without our secret key nobody else can attach a Checkout to them.
const PRICE_IDS: Record<Exclude<Tier, "enterprise_plus">, string> = {
  starter:    "price_1TOj2pDffjr690qOwgavreSA",
  pro:        "price_1TOj3kDffjr690qOijRWNO0v",
  enterprise: "price_1TOj4QDffjr690qOvgEZmj6s",
};

// Reverse lookup so the webhook can map incoming Price IDs back to tiers.
function tierForPriceId(priceId: string): Tier | null {
  for (const [t, id] of Object.entries(PRICE_IDS)) {
    if (id === priceId) return t as Tier;
  }
  return null;
}

const STRIPE_API = "https://api.stripe.com/v1";

// Tiny form-encode helper for Stripe's REST API (it wants
// application/x-www-form-urlencoded, not JSON, even in 2026).
function form(obj: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    p.append(k, String(v));
  }
  return p.toString();
}

async function stripeFetch(path: string, init: RequestInit = {}): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  const res = await fetch(STRIPE_API + path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "authorization": `Bearer ${key}`,
      "stripe-version": "2025-04-30.acacia",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe ${path} → ${res.status}: ${body}`);
  }
  return await res.json();
}

// ════════════════════════════════════════════════════════════
// ─── 1. CHECKOUT (called from the dashboard "Subscribe" btn)
// ════════════════════════════════════════════════════════════

// Returns a Checkout URL the frontend should redirect to.
// Implemented as a mutation (not action) on purpose — it writes the
// stripeCustomers row before kicking off Stripe.
export const createCheckout = mutation({
  args: { tier: v.string() },
  handler: async (ctx, { tier }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    if (tier === "enterprise_plus") throw new Error("contact sales for enterprise+");
    if (!(tier in PRICE_IDS)) throw new Error("unknown tier");

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("user vanished");

    // Reuse stripe customer if we have one (don't dupe).
    let mapping = await ctx.db.query("stripeCustomers")
      .withIndex("by_user", q => q.eq("userId", userId)).first();

    let customerId: string;
    if (mapping) {
      customerId = mapping.stripeCustomerId;
    } else {
      const customer = await stripeFetch("/customers", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          email: (user as any).email ?? "",
          name: (user as any).name ?? "",
          "metadata[suprabench_user_id]": userId,
        }),
      });
      customerId = customer.id;
      await ctx.db.insert("stripeCustomers", {
        userId, stripeCustomerId: customerId,
        email: (user as any).email ?? "",
        createdAt: Date.now(),
      });
    }

    const returnUrl = process.env.STRIPE_RETURN_URL ?? "https://suprabench.com/#api";
    const session = await stripeFetch("/checkout/sessions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        mode: "subscription",
        customer: customerId,
        "line_items[0][price]": PRICE_IDS[tier as Exclude<Tier, "enterprise_plus">],
        "line_items[0][quantity]": 1,
        success_url: `${returnUrl}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${returnUrl}?stripe=cancel`,
        // Pre-fill tax info collection so Stripe handles EU VAT for us.
        automatic_tax: "true",
        customer_update: "auto",
        billing_address_collection: "required",
        "metadata[suprabench_user_id]": userId,
        "metadata[tier]": tier,
        // Idempotency: a single click = a single session.
        // (The frontend should debounce, but belt + suspenders.)
      }),
    });

    return { url: session.url };
  },
});

// Customer billing portal — lets users update card / cancel sub
// without us building any UI for that. Just redirect to the URL.
export const createBillingPortalSession = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    const mapping = await ctx.db.query("stripeCustomers")
      .withIndex("by_user", q => q.eq("userId", userId)).first();
    if (!mapping) throw new Error("no stripe customer");

    const returnUrl = process.env.STRIPE_RETURN_URL ?? "https://suprabench.com/#api";
    const portal = await stripeFetch("/billing_portal/sessions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ customer: mapping.stripeCustomerId, return_url: returnUrl }),
    });
    return { url: portal.url };
  },
});

// ════════════════════════════════════════════════════════════
// ─── 2. WEBHOOK ────────────────────────────────────────────
// ════════════════════════════════════════════════════════════

// Stripe sends events to /stripe/webhook with a signed payload. We
// verify the signature, dedupe by event ID, then fan out to mutations
// that update our local mirror tables.
export function registerStripeRoutes(http: ReturnType<typeof httpRouter>) {
  http.route({
    path: "/stripe/webhook",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const sig = request.headers.get("stripe-signature");
      if (!sig) return new Response("missing signature", { status: 400 });
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return new Response("server not configured", { status: 500 });

      const body = await request.text();
      const verified = await verifyStripeSignature(body, sig, secret);
      if (!verified) return new Response("bad signature", { status: 400 });

      let event: any;
      try { event = JSON.parse(body); }
      catch { return new Response("bad json", { status: 400 }); }

      // Idempotency. Stripe retries on 5xx; we must not double-process.
      const seen = await ctx.runQuery(internal.stripe.findEvent, { stripeEventId: event.id });
      if (seen) return new Response("ok (dup)", { status: 200 });

      try {
        await ctx.runMutation(internal.stripe.handleEvent, { event });
      } catch (e: any) {
        console.error("[stripe] handler failed:", e);
        return new Response("handler error", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    }),
  });
}

export const findEvent = internalQuery({
  args: { stripeEventId: v.string() },
  handler: async (ctx, { stripeEventId }) =>
    await ctx.db.query("stripeEvents")
      .withIndex("by_event_id", q => q.eq("stripeEventId", stripeEventId)).first(),
});

// Single fan-out point. Keeps signature-verify code tiny and lets the
// handler logic be unit-testable without HTTP machinery.
export const handleEvent = internalMutation({
  args: { event: v.any() },
  handler: async (ctx, { event }) => {
    // Mark as seen FIRST. If the per-event handler throws, we still
    // want Stripe to stop retrying the same event forever; the user
    // can manually reconcile via the billing portal.
    await ctx.db.insert("stripeEvents", {
      stripeEventId: event.id, type: event.type, processedAt: Date.now(),
    });

    switch (event.type) {
      case "checkout.session.completed": {
        // Just log — the subsequent customer.subscription.created
        // event has all the info we need to mirror the sub.
        return;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const customerId = sub.customer as string;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const tier = priceId ? tierForPriceId(priceId) : null;
        if (!tier) {
          console.warn(`[stripe] sub for unknown price ${priceId}`);
          return;
        }

        const customerMap = await ctx.db.query("stripeCustomers")
          .withIndex("by_customer", q => q.eq("stripeCustomerId", customerId)).first();
        if (!customerMap) {
          console.warn(`[stripe] sub for unknown customer ${customerId}`);
          return;
        }

        const existing = await ctx.db.query("stripeSubscriptions")
          .withIndex("by_subscription", q => q.eq("stripeSubscriptionId", sub.id)).first();
        const data = {
          userId: customerMap.userId,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          stripePriceId: priceId,
          tier,
          status: sub.status,
          currentPeriodEnd: (sub.current_period_end ?? 0) * 1000,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        if (existing) await ctx.db.patch(existing._id, data);
        else          await ctx.db.insert("stripeSubscriptions", data);

        // Cascade onto API keys: enable / disable based on sub status.
        await cascadeSubToKeys(ctx, sub.id, sub.status);
        return;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const existing = await ctx.db.query("stripeSubscriptions")
          .withIndex("by_subscription", q => q.eq("stripeSubscriptionId", sub.id)).first();
        if (existing) await ctx.db.patch(existing._id, {
          status: "canceled", updatedAt: Date.now(),
        });
        await cascadeSubToKeys(ctx, sub.id, "canceled");
        return;
      }

      case "invoice.payment_failed": {
        // Stripe will retry; we just mirror the new sub status (usually
        // becomes past_due → unpaid → canceled). Keys keep working
        // until status leaves "active"/"trialing".
        return;
      }

      default:
        // Ignore other event types.
        return;
    }
  },
});

async function cascadeSubToKeys(ctx: any, stripeSubscriptionId: string, status: string) {
  const keys = await ctx.db.query("apiKeys")
    .withIndex("by_subscription", (q: any) => q.eq("stripeSubscriptionId", stripeSubscriptionId))
    .collect();
  for (const k of keys) {
    await ctx.db.patch(k._id, {
      stripeSubscriptionStatus: status,
      // Auto-revoke on canceled. The user can create a new key after
      // resubscribing — we don't unrevoke automatically (they may
      // have leaked the old one in the interim).
      ...(status === "canceled" ? { revokedAt: Date.now() } : {}),
    });
  }
}

// ════════════════════════════════════════════════════════════
// ─── 3. SIGNATURE VERIFY (HMAC-SHA256, Stripe's scheme) ────
// ════════════════════════════════════════════════════════════
//
// Stripe-Signature header looks like:
//   t=1614000000,v1=hexsig,v1=hexsig,...
// We compute HMAC-SHA256 of `${t}.${rawBody}` with the webhook secret
// and check it matches any of the v1 sigs (Stripe rotates secrets).
// Reject if t is older than 5 minutes (replay protection).

async function verifyStripeSignature(body: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map(p => {
      const [k, ...rest] = p.split("=");
      return [k.trim(), rest.join("=").trim()];
    })
  );
  const t = parseInt(parts["t"] ?? "0", 10);
  if (!t) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false; // 5-min window

  // Stripe header may carry multiple v1 signatures.
  const v1Sigs = header
    .split(",")
    .map(p => p.split("=").map(s => s.trim()))
    .filter(([k]) => k === "v1")
    .map(([, v]) => v);
  if (v1Sigs.length === 0) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return v1Sigs.some(s => timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

   ════════════════════════════════════════════════════════════ */
