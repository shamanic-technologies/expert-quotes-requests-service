import type { FeaturedCredentials } from "./featured-client.js";

export class KeyServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyServiceUnavailableError";
  }
}

interface DecryptResponse {
  provider: string;
  key: string;
  keySource: "org" | "platform";
  userId?: string;
}

async function fetchDecryptedKey(
  provider: string,
  orgId: string,
  userId: string | undefined,
  runId: string | undefined,
  fetchImpl: typeof fetch
): Promise<string> {
  const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL;
  const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;
  if (!KEY_SERVICE_URL || !KEY_SERVICE_API_KEY) {
    throw new KeyServiceUnavailableError(
      "key-service not configured: KEY_SERVICE_URL or KEY_SERVICE_API_KEY missing"
    );
  }

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": orgId,
    "x-caller-service": "expert-quotes-requests-service",
  };
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;

  let response: Response;
  try {
    response = await fetchImpl(
      `${KEY_SERVICE_URL}/keys/${provider}/decrypt`,
      { method: "GET", headers }
    );
  } catch (err) {
    throw new KeyServiceUnavailableError(
      `key-service network error fetching ${provider}: ${(err as Error).message}`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new KeyServiceUnavailableError(
      `key-service GET /keys/${provider}/decrypt failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as DecryptResponse;
  if (!data.key) {
    throw new Error(
      `key-service returned no key for provider ${provider}`
    );
  }
  return data.key;
}

/**
 * Resolve Featured.com username + password from key-service.
 * Both `featured-username` and `featured-password` are registered as separate
 * platform keys by the dashboard at startup instrumentation.
 */
export async function getFeaturedCredentials(
  orgId: string,
  userId?: string,
  runId?: string,
  fetchImpl: typeof fetch = fetch
): Promise<FeaturedCredentials> {
  const [username, password] = await Promise.all([
    fetchDecryptedKey("featured-username", orgId, userId, runId, fetchImpl),
    fetchDecryptedKey("featured-password", orgId, userId, runId, fetchImpl),
  ]);
  return { username, password };
}
