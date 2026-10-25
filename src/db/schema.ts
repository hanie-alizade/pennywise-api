import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  date,
  timestamp,
  primaryKey,
  unique,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// 1. Users
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// 2. Workspaces
// ---------------------------------------------------------------------------
export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  currency: varchar('currency', { length: 3 }).default('MYR').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// 3. Memberships
// ---------------------------------------------------------------------------
export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 20 }).notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('memberships_workspace_id_idx').on(table.workspaceId),
    index('memberships_user_id_idx').on(table.userId),
    check('memberships_role_check', sql`${table.role} IN ('owner', 'member')`),
  ]
);

// ---------------------------------------------------------------------------
// 4. Refresh Tokens (Multi-device, rotating tokens)
// ---------------------------------------------------------------------------
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    deviceLabel: text('device_label'),
  },
  (table) => [
    index('refresh_tokens_user_id_idx').on(table.userId),
    index('refresh_tokens_token_hash_idx').on(table.tokenHash),
  ]
);

// ---------------------------------------------------------------------------
// 5. Categories
// ---------------------------------------------------------------------------
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    type: varchar('type', { length: 10 }).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('categories_workspace_id_idx').on(table.workspaceId),
    check('categories_type_check', sql`${table.type} IN ('income', 'expense')`),
    uniqueIndex('categories_workspace_name_type_unique')
      .on(table.workspaceId, sql`lower(${table.name})`, table.type)
      .where(sql`${table.archivedAt} IS NULL`),
  ]
);

// ---------------------------------------------------------------------------
// 6. Subcategories
// ---------------------------------------------------------------------------
export const subcategories = pgTable(
  'subcategories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('subcategories_workspace_id_idx').on(table.workspaceId),
    index('subcategories_category_id_idx').on(table.categoryId),
    unique('subcategories_id_category_id_unique').on(table.id, table.categoryId),
    uniqueIndex('subcategories_category_name_unique')
      .on(table.categoryId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} IS NULL`),
  ]
);

// ---------------------------------------------------------------------------
// 7. Months
// ---------------------------------------------------------------------------
export const months = pgTable(
  'months',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('months_workspace_id_idx').on(table.workspaceId),
    unique('months_workspace_year_month_unique').on(table.workspaceId, table.year, table.month),
    check('months_month_check', sql`${table.month} >= 1 AND ${table.month} <= 12`),
    check('months_year_check', sql`${table.year} >= 2000 AND ${table.year} <= 2100`),
  ]
);

// ---------------------------------------------------------------------------
// 8. Budget Lines
// ---------------------------------------------------------------------------
export const budgetLines = pgTable(
  'budget_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    monthId: uuid('month_id')
      .notNull()
      .references(() => months.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id'),
    expectedAmount: bigint('expected_amount', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('budget_lines_workspace_id_idx').on(table.workspaceId),
    index('budget_lines_month_category_idx').on(table.monthId, table.categoryId),
    foreignKey({
      columns: [table.subcategoryId, table.categoryId],
      foreignColumns: [subcategories.id, subcategories.categoryId],
      name: 'budget_lines_subcategory_category_fk',
    }).onDelete('cascade'),
    uniqueIndex('budget_lines_month_category_unique')
      .on(table.monthId, table.categoryId)
      .where(sql`${table.subcategoryId} IS NULL`),
    uniqueIndex('budget_lines_month_subcategory_unique')
      .on(table.monthId, table.subcategoryId)
      .where(sql`${table.subcategoryId} IS NOT NULL`),
    check('budget_lines_expected_amount_check', sql`${table.expectedAmount} >= 0`),
  ]
);

// ---------------------------------------------------------------------------
// 9. Transactions
// ---------------------------------------------------------------------------
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    budgetLineId: uuid('budget_line_id')
      .notNull()
      .references(() => budgetLines.id, { onDelete: 'cascade' }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    transactionDate: date('transaction_date', { mode: 'string' }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('transactions_workspace_id_idx').on(table.workspaceId),
    index('transactions_line_date_idx').on(table.budgetLineId, table.transactionDate),
    check('transactions_amount_check', sql`${table.amount} > 0`),
  ]
);

// ---------------------------------------------------------------------------
// 10. Rate Limits (Serverless-safe persistent rate limiting table)
// ---------------------------------------------------------------------------
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').default(1).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('rate_limits_expires_at_idx').on(table.expiresAt)]
);
