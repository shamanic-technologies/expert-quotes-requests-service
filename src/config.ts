const ttlRaw = process.env.FEATURED_OPPORTUNITY_TTL_MS;
const parsedTtl = ttlRaw ? Number(ttlRaw) : NaN;

export const config = {
  port: Number(process.env.PORT) || 3055,
  databaseUrl: process.env.EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL,
  serviceApiKey: process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY,
  keyServiceUrl: process.env.KEY_SERVICE_URL,
  keyServiceApiKey: process.env.KEY_SERVICE_API_KEY,
  runsServiceUrl: process.env.RUNS_SERVICE_URL,
  runsServiceApiKey: process.env.RUNS_SERVICE_API_KEY,
  brandServiceUrl: process.env.BRAND_SERVICE_URL,
  brandServiceApiKey: process.env.BRAND_SERVICE_API_KEY,
  featuredApiBaseUrl:
    process.env.FEATURED_API_BASE_URL ||
    "https://www.connectively.us/api/external-users",
  opportunityTtlMs: Number.isFinite(parsedTtl) ? parsedTtl : 5 * 60 * 1000,
};
