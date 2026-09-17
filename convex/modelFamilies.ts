// Provider-neutral family identity with a deliberately small set of
// unambiguous name-derived overrides. Product tier/version belongs to the
// family; execution settings such as reasoning effort stay configurations.
//
// The rule itself lives in the shared ranking core so the browser (tag
// filter, simulator) groups families exactly like the server does.
import "../public/js/supra-rank-core.js";

const core = (globalThis as any).SupraRankCore as {
  canonicalFamilyTag: (
    modelName: string,
    requestedFamilyTag?: string | null
  ) => string | undefined;
};

/**
 * Return the canonical ranking family for known unambiguous tiered names.
 * Unknown names keep the curator/user-supplied family unchanged: this helper
 * must not invent mappings for provider taxonomies we have not reviewed.
 */
export function canonicalFamilyTag(
  modelName: string,
  requestedFamilyTag?: string | null,
): string | undefined {
  return core.canonicalFamilyTag(modelName, requestedFamilyTag);
}
