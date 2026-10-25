import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.js';
import { env } from '../config/env.js';

// Configure Neon WebSocket constructor for Node.js
if (!neonConfig.webSocketConstructor) {
  neonConfig.webSocketConstructor = ws;
}

// Preserve pool instance across serverless function re-invocations
const globalForDb = globalThis as unknown as {
  pool: Pool | undefined;
};

const connectionString = env.DATABASE_URL || 'postgres://localhost:5432/pennywise_dev';

export const pool = globalForDb.pool ?? new Pool({ connectionString });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pool = pool;
}

export let db = drizzle(pool, { schema });
export type Database = typeof db;

export function setTestDb(testDb: unknown) {
  db = testDb as Database;
}
