process.env.NODE_ENV = "test";
process.env.EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY = "test-api-key";
process.env.EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL =
  process.env.EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL ||
  "postgresql://mock:mock@localhost:5432/mock";
process.env.FEATURED_USERNAME = "test-featured-user";
process.env.FEATURED_PASSWORD = "test-featured-pass";
process.env.FEATURED_API_BASE_URL = "https://featured.test/api/external-users";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "test-brand-key";
process.env.RUNS_SERVICE_URL = "http://runs.test";
process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
