function getConfig() {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url) throw new Error("BRAND_SERVICE_URL is not set");
  if (!apiKey) throw new Error("BRAND_SERVICE_API_KEY is not set");
  return { url, apiKey };
}

/**
 * Canonical minimal brand shape returned by brand-service
 * `GET /internal/brands/{id}`. Business fields (industry, geography,
 * target audience, description) are no longer on this shape — they must be
 * fetched via `POST /internal/brands/extract-fields` if ever needed.
 */
export interface BrandContext {
  id: string;
  domain: string;
  url: string;
  name: string;
  /** Logo image URL. Lazy-filled by brand-service with a deterministic
   *  logo.dev URL when absent, so this is always present. */
  logoUrl: string;
  createdAt: string;
  updatedAt: string;
}

function buildHeaders(
  orgId: string,
  userId?: string,
  runId?: string,
  audienceId?: string
) {
  const { apiKey } = getConfig();
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": orgId,
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;
  if (audienceId) headers["x-audience-id"] = audienceId;
  return headers;
}

export async function getBrand(
  brandId: string,
  orgId: string,
  userId?: string,
  runId?: string,
  audienceId?: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrandContext> {
  const { url } = getConfig();
  const path = `/internal/brands/${brandId}?orgId=${orgId}`;
  const response = await fetchImpl(`${url}${path}`, {
    method: "GET",
    headers: buildHeaders(orgId, userId, runId, audienceId),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `brand-service GET ${path} failed (${response.status}): ${body}`
    );
  }
  const data = (await response.json()) as { brand?: BrandContext };
  if (!data.brand) throw new Error("brand-service response missing brand");
  return data.brand;
}
