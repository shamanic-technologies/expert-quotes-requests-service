import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { Sql } from "postgres";
import * as schema from "./schema.js";

let sqlClient: Sql | null = null;
let dbInstance: PostgresJsDatabase<typeof schema> | null = null;

function getConnectionString(): string {
  const connectionString = process.env.EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL is not set");
  }
  return connectionString;
}

export function getSql(): Sql {
  if (!sqlClient) {
    sqlClient = postgres(getConnectionString(), {
      idle_timeout: 20,
      max_lifetime: 300,
      connect_timeout: 10,
      max: 10,
    });
  }
  return sqlClient;
}

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_, prop) {
    if (!dbInstance) {
      dbInstance = drizzle(getSql(), { schema });
    }
    return (dbInstance as any)[prop];
  },
});

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
    dbInstance = null;
  }
}
