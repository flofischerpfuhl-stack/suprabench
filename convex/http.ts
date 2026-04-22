// HTTP route registration.
//
// Only the auth routes and the public `/v1/*` API are registered
// here. The Stripe checkout / billing-portal / webhook endpoints
// from convex/stripe.future.ts stay off until paid tiers launch —
// see ACTIVATION.md step 2 for the remaining wiring needed then.

import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { registerApiRoutes } from "./api";

const http = httpRouter();
auth.addHttpRoutes(http);
registerApiRoutes(http);

export default http;
