import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featuredProfiles, featuredProfileAttribution } from "../db/schema.js";
import { getBrand } from "./brand-client.js";
import { normalizeDomain } from "./featured-normalize.js";
import type { FeaturedClient, FeaturedProfile } from "./featured-client.js";

/**
 * Resolve which existing Featured/Connectively profile submits for a brand,
 * keyed on the brand's DOMAIN via the `featured_profile_attribution` registry.
 *
 * Connectively profiles are PEOPLE on one shared account and `add-profile` is
 * unusable (server-side 500 for every payload shape — see CLAUDE.md), so we
 * NEVER create a profile. The `/profiles` API also exposes NO company URL, so
 * the domain → profileId map is maintained by us (seeded in the registry table)
 * rather than read from Connectively. A brand's domain (from brand-service) is
 * matched against the seeded map; the mapped profile is validated to still be
 * live on the account before use. Unmapped domain, or a mapped profile that is
 * gone / inactive / flagged, fails loud — no silent fallback pick.
 *
 * @throws when the brand domain is unresolvable, unmapped, or the mapped
 *         profile is absent / inactive / flagged on the account.
 */
export async function resolveProfileIdForDomain(
  rawDomain: string,
  client: FeaturedClient
): Promise<number> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    throw new Error(
      `brand domain "${rawDomain}" is not a resolvable hostname; cannot map to a Featured profile`
    );
  }

  const mapping = (
    await db
      .select()
      .from(featuredProfileAttribution)
      .where(eq(featuredProfileAttribution.domain, domain))
      .limit(1)
  )[0];
  if (!mapping) {
    throw new Error(
      `no Featured profile mapped for brand domain "${domain}"; seed featured_profile_attribution`
    );
  }
  const featuredProfileId = mapping.featuredProfileId;

  // Validate the mapped profile is still live on the account — a deleted /
  // hidden / flagged profile must fail loud, not submit under a stale id.
  const profiles: FeaturedProfile[] = await client.listProfiles();
  const match = profiles.find((p) => p.profileId === featuredProfileId);
  if (!match) {
    throw new Error(
      `mapped Featured profile ${featuredProfileId} (domain "${domain}") not found among account profiles [${profiles
        .map((p) => p.profileId)
        .join(", ")}]`
    );
  }
  if (match.isActive === false || match.isFlagged === true) {
    throw new Error(
      `mapped Featured profile ${featuredProfileId} (domain "${domain}") is inactive or flagged`
    );
  }
  return featuredProfileId;
}

/**
 * Resolve the Featured profile to submit under for (orgId, brandId).
 *
 * Cache hit: a local `featured_profiles` row short-circuits (no brand-service /
 * Connectively calls). Cache miss: resolve the brand's domain via brand-service,
 * map it to a Featured profile through the attribution registry, then persist
 * the (org, brand) → profileId mapping so future submits skip the lookup.
 */
export async function ensureFeaturedProfile(input: {
  orgId: string;
  brandId: string;
  client: FeaturedClient;
  userId?: string;
  runId?: string;
  audienceId?: string;
  getBrandFn?: typeof getBrand;
}): Promise<{ featuredProfileId: number }> {
  const existing = (
    await db
      .select()
      .from(featuredProfiles)
      .where(
        and(
          eq(featuredProfiles.orgId, input.orgId),
          eq(featuredProfiles.brandId, input.brandId)
        )
      )
      .limit(1)
  )[0];
  if (existing) {
    return { featuredProfileId: existing.featuredProfileId };
  }

  const getBrandFn = input.getBrandFn ?? getBrand;
  const brand = await getBrandFn(
    input.brandId,
    input.orgId,
    input.userId,
    input.runId,
    input.audienceId
  );
  const featuredProfileId = await resolveProfileIdForDomain(
    brand.domain,
    input.client
  );

  const inserted = await db
    .insert(featuredProfiles)
    .values({
      orgId: input.orgId,
      brandId: input.brandId,
      featuredProfileId,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return { featuredProfileId: inserted[0].featuredProfileId };
  }

  // Lost a concurrent insert race → the winning row is now present.
  const row = (
    await db
      .select()
      .from(featuredProfiles)
      .where(
        and(
          eq(featuredProfiles.orgId, input.orgId),
          eq(featuredProfiles.brandId, input.brandId)
        )
      )
      .limit(1)
  )[0];
  return { featuredProfileId: row.featuredProfileId };
}
