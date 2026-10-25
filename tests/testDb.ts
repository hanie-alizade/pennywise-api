import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema.js';
import { setTestDb } from '../src/db/client.js';

let client: PGlite | null = null;
let testDbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export async function setupTestDb() {
  if (!client) {
    client = new PGlite();
    testDbInstance = drizzle(client, { schema });

    // Read and execute the initial migration SQL
    const migrationPath = path.resolve(__dirname, '../drizzle/0000_outgoing_susan_delgado.sql');
    const rawSql = fs.readFileSync(migrationPath, 'utf8');

    // Split on statement-breakpoint comments and execute
    const statements = rawSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await client.exec(stmt);
    }
  }

  setTestDb(testDbInstance);
  return testDbInstance!;
}

export async function resetTestDb() {
  if (client) {
    // Truncate all data tables between tests to ensure test isolation
    await client.exec(`
      TRUNCATE TABLE transactions, budget_lines, subcategories, categories, months, memberships, refresh_tokens, rate_limits, workspaces, users CASCADE;
    `);
  }
}
