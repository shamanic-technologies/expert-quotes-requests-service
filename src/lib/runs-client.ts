const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

function getRunsConfig() {
  if (!RUNS_SERVICE_URL) throw new Error("RUNS_SERVICE_URL is not set");
  if (!RUNS_SERVICE_API_KEY) throw new Error("RUNS_SERVICE_API_KEY is not set");
  return { url: RUNS_SERVICE_URL, apiKey: RUNS_SERVICE_API_KEY };
}

export interface CreateRunResponse {
  id: string;
  parentRunId: string | null;
  serviceName: string;
  taskName: string;
}

export async function createChildRun(
  request: {
    parentRunId?: string;
    serviceName: string;
    taskName: string;
    audienceId?: string;
  },
  orgId?: string,
  userId?: string
): Promise<CreateRunResponse> {
  const { url, apiKey } = getRunsConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (orgId) headers["x-org-id"] = orgId;
  if (userId) headers["x-user-id"] = userId;
  if (request.parentRunId) headers["x-run-id"] = request.parentRunId;
  // Audience attribution: forward so the child run carries audience_id
  // (runs-service: header takes precedence, else inherited from parent).
  if (request.audienceId) headers["x-audience-id"] = request.audienceId;

  const response = await fetch(`${url}/v1/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      serviceName: request.serviceName,
      taskName: request.taskName,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Runs-service POST /v1/runs failed (${response.status}): ${body}`
    );
  }

  return response.json() as Promise<CreateRunResponse>;
}

export async function closeRun(
  runId: string,
  status: "completed" | "failed",
  orgId?: string,
  userId?: string
): Promise<void> {
  const { url, apiKey } = getRunsConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (orgId) headers["x-org-id"] = orgId;
  if (userId) headers["x-user-id"] = userId;

  const response = await fetch(`${url}/v1/runs/${runId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Runs-service PATCH /v1/runs/${runId} failed (${response.status}): ${body}`
    );
  }
}

export interface AddCostsItem {
  costName: string;
  costSource: "platform" | "org";
  quantity: number;
  status?: "provisioned" | "actual" | "cancelled";
  idempotencyKey?: string;
}

export interface CostIdentity {
  orgId: string;
  userId?: string;
  brandId?: string;
  audienceId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

export interface CostRow {
  id: string;
  runId: string;
  costName: string;
  costSource: "platform" | "org";
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  status: "actual" | "provisioned" | "cancelled";
  idempotencyKey: string | null;
  createdAt: string;
}

function costIdentityHeaders(
  apiKey: string,
  runId: string,
  identity: CostIdentity
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-run-id": runId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.audienceId) headers["x-audience-id"] = identity.audienceId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  return headers;
}

export async function addCosts(
  runId: string,
  items: AddCostsItem[],
  identity: CostIdentity,
  fetchImpl: typeof fetch = fetch
): Promise<CostRow[]> {
  const { url, apiKey } = getRunsConfig();

  const response = await fetchImpl(`${url}/v1/runs/${runId}/costs`, {
    method: "POST",
    headers: costIdentityHeaders(apiKey, runId, identity),
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Runs-service POST /v1/runs/${runId}/costs failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as { costs: CostRow[] };
  return data.costs;
}

export async function updateCostStatus(
  runId: string,
  costId: string,
  status: "actual" | "cancelled",
  identity: CostIdentity,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const { url, apiKey } = getRunsConfig();

  const response = await fetchImpl(
    `${url}/v1/runs/${runId}/costs/${costId}`,
    {
      method: "PATCH",
      headers: costIdentityHeaders(apiKey, runId, identity),
      body: JSON.stringify({ status }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Runs-service PATCH /v1/runs/${runId}/costs/${costId} failed (${response.status}): ${body}`
    );
  }
}
