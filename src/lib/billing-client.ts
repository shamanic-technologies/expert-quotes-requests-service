/**
 * billing-service client — credit authorization for platform-key spend.
 *
 * Featured pitch submission is platform-key spend (Featured creds are platform
 * keys resolved via key-service). Per the cost-declaration rule
 * (provision → authorize → execute → actualize), we MUST check affordability
 * against the org's customer balance before the metered call.
 *
 * Fail loud: missing env / non-2xx throws. No silent fallback.
 */

export interface CreditItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeCreditParams {
  items: CreditItem[];
  description: string;
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

export interface AuthorizeCreditResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
}

export class BillingServiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BillingServiceError";
  }
}

export async function authorizeCredit(
  params: AuthorizeCreditParams,
  fetchImpl: typeof fetch = fetch
): Promise<AuthorizeCreditResult> {
  const baseUrl = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new BillingServiceError(
      "BILLING_SERVICE_URL is not set",
      500
    );
  }
  if (!apiKey) {
    throw new BillingServiceError(
      "BILLING_SERVICE_API_KEY is not set",
      500
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "x-org-id": params.orgId,
  };
  if (params.userId) headers["x-user-id"] = params.userId;
  if (params.runId) headers["x-run-id"] = params.runId;
  if (params.brandId) headers["x-brand-id"] = params.brandId;
  if (params.campaignId) headers["x-campaign-id"] = params.campaignId;
  if (params.featureSlug) headers["x-feature-slug"] = params.featureSlug;
  if (params.workflowSlug) headers["x-workflow-slug"] = params.workflowSlug;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/customer_balance/authorize`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        items: params.items,
        description: params.description,
      }),
    });
  } catch (err) {
    throw new BillingServiceError(
      `billing-service network error: ${(err as Error).message}`,
      502
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new BillingServiceError(
      `billing-service POST /v1/customer_balance/authorize failed (${response.status}): ${body}`,
      502
    );
  }

  return response.json() as Promise<AuthorizeCreditResult>;
}
