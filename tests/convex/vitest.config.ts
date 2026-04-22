import { defineConfig } from "vitest/config";

// convex-test runs mutations on the edge-runtime so that crypto.subtle
// (used in sha256Hex for API key hashing) is available. Without the
// @edge-runtime/vm server pool, any test touching the api.ts hash path
// throws "crypto.subtle is not a function".
export default defineConfig({
  test: {
    server: { deps: { inline: ["convex-test"] } },
    pool: "forks",
    environment: "edge-runtime",
    // The convex/ source lives one directory up; resolve through the
    // workspace root so imports like "../../convex/_generated/api"
    // work from every test file.
    include: ["**/*.test.ts"],
    testTimeout: 30_000,
  },
});
