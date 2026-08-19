import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit runs outside Next, so nothing has loaded .env.local for us.
 * Node can do it natively — no dotenv dependency needed. Missing file is fine:
 * `generate` works offline, and only `migrate`/`push`/`studio` need a real URL.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // not present — keep going
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  casing: "snake_case",
  strict: true,
  verbose: true,
});
