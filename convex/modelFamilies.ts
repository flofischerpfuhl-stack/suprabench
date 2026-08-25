// Provider-neutral family identity with a deliberately small set of
// unambiguous name-derived overrides. Product tier/version belongs to the
// family; execution settings such as reasoning effort stay configurations.

const GPT_56_TIER = /^GPT-5\.6\s+(Sol|Terra|Luna)(?:\s+\([^)]*\))?$/i;
const MUSE_SPARK_VERSION = /^Muse Spark\s+(1\.\d+)(?:\s+\([^)]*\))?$/i;

const GPT_56_TIER_NAMES: Record<string, string> = {
  sol: "Sol",
  terra: "Terra",
  luna: "Luna",
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
  const name = modelName.trim();

  const gpt56 = name.match(GPT_56_TIER);
  if (gpt56) return `GPT-5.6 ${GPT_56_TIER_NAMES[gpt56[1].toLowerCase()]}`;

  const muse = name.match(MUSE_SPARK_VERSION);
  if (muse) return `Muse Spark ${muse[1]}`;

  const requested = requestedFamilyTag?.trim();
  return requested || undefined;
}
