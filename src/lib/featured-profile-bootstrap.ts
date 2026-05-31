import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featuredProfiles } from "../db/schema.js";
import type { FeaturedClient, FeaturedProfile } from "./featured-client.js";

/**
 * Pick which existing Featured profile to submit under.
 *
 * Featured profiles are PEOPLE (firstName/lastName/email/linkedinUrl) on one
 * shared platform account. `add-profile` is unusable — it returns a server-side
 * 500 for every payload shape (confirmed live 2026-05-31) — so we NEVER create a
 * profile; we resolve to one that already exists on the account.
 *
 * Selection: an explicit `FEATURED_PROFILE_ID` pin wins (must exist on the
 * account); otherwise the single active, non-flagged profile. Zero or ambiguous
 * (>1) without a pin fails loud — no silent fallback.
 */
export function selectFeaturedProfileId(
  profiles: FeaturedProfile[],
  pinnedId?: string
): number {
  if (pinnedId !== undefined && pinnedId.trim() !== "") {
    const pinned = Number(pinnedId);
    if (!Number.isInteger(pinned)) {
      throw new Error(
        `FEATURED_PROFILE_ID must be an integer, got "${pinnedId}"`
      );
    }
    const match = profiles.find((p) => p.profileId === pinned);
    if (!match) {
      throw new Error(
        `FEATURED_PROFILE_ID=${pinned} not found among Featured profiles [${profiles
          .map((p) => p.profileId)
          .join(", ")}]`
      );
    }
    return match.profileId;
  }

  const usable = profiles.filter(
    (p) => p.isActive !== false && p.isFlagged !== true
  );
  if (usable.length === 1) {
    return usable[0].profileId;
  }

  throw new Error(
    `No single usable Featured profile (found ${usable.length} active, non-flagged of ${profiles.length} total); set FEATURED_PROFILE_ID to disambiguate`
  );
}

/**
 * Resolve the Featured profile to submit under for (orgId, brandId).
 *
 * Cache hit: a local `featured_profiles` row short-circuits. Cache miss: resolve
 * an existing account profile via `listProfiles()` and persist the mapping so
 * future submits skip the lookup. Many brands legitimately map to the SAME
 * Featured profile (the human expert who answers) — client/brand context lives
 * in the answer text, not the profile.
 */
export async function ensureFeaturedProfile(input: {
  orgId: string;
  brandId: string;
  client: FeaturedClient;
  pinnedProfileId?: string;
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

  const profiles = await input.client.listProfiles();
  const featuredProfileId = selectFeaturedProfileId(
    profiles,
    input.pinnedProfileId ?? process.env.FEATURED_PROFILE_ID
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
