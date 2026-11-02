# Pennywise Backend

REST API for **Pennywise**, a personal budgeting and expense tracking application.

Built with **Node.js**, **Express**, **TypeScript**, **Drizzle ORM**, and **PostgreSQL (Neon)**. Deployed as a serverless REST API on **Vercel Functions**.

---

## 1. Architecture & Principles

- **Architecture:** `React Native Expo Client → HTTPS REST API (Express on Vercel) → Neon Serverless PostgreSQL`.
- **Tenancy:** Workspace-scoped isolation from day one. Data belongs to a `workspace` resolved exclusively from verified authentication tokens. Accessing resources from another workspace returns `404 Not Found` (never leaking existence).
- **Money:** Stored as integer minor units (`bigint({ mode: 'number' })`, e.g. sen/cents) end-to-end. Floating-point numbers are strictly forbidden for currency amounts.
- **Actuals:** `Actual` is not stored in the database. It is dynamically calculated as `SUM(transactions.amount)` on budget lines. When a line has no transactions, its `Actual` is `null` (unset), which is visibly and logically distinct from `0`.
- **Calendar Dates:** Stored as `date` (`YYYY-MM-DD`). The client always sends the user's local calendar date; the server never guesses "today". Transactions must fall in the same calendar year and month as their budget line.
- **Anti Double-Counting:** Categories with subcategories compute their totals from child lines. Overall totals strictly sum leaf lines only.
- **Stateless Serverless:** No process-local state is relied upon. Connection pooling is managed using Neon's WebSocket pool (`@neondatabase/serverless` + `ws`). Rate limiting is backed by PostgreSQL.

---

## 2. Prerequisites

- **Node.js:** `v20+` (tested on Node `v22`)
- **Package Manager:** `pnpm` (`v9+`)
- **Database:** PostgreSQL on [Neon](https://neon.tech) (or local PostgreSQL / WASM PGlite for tests)

---

## 3. Environment Variables

Create a `.env` file in the project root based on `.env.example`:

```bash
cp .env.example .env
```

| Variable                     | Description                                                                              | Example / Default                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`                   | Application environment                                                                  | `development` / `production` / `test`                                          |
| `PORT`                       | Local dev server listening port                                                          | `3000`                                                                         |
| `DATABASE_URL`               | **Pooled** Neon PostgreSQL connection string (used at runtime by the app)                | `postgresql://user:pass@ep-...-pooler.region.neon.tech/neondb?sslmode=require` |
| `DIRECT_DATABASE_URL`        | **Direct (unpooled)** Neon connection string (used by Drizzle Kit for schema migrations) | `postgresql://user:pass@ep-....region.neon.tech/neondb?sslmode=require`        |
| `JWT_ACCESS_SECRET`          | Secret key for signing access JWTs (min 32 characters)                                   | Secure random 256-bit string                                                   |
| `JWT_ACCESS_EXPIRES_IN`      | Access token lifetime in seconds                                                         | `900` (15 minutes)                                                             |
| `REFRESH_TOKEN_EXPIRES_DAYS` | Refresh token lifetime in days                                                           | `30`                                                                           |

> [!IMPORTANT]
> **Neon Connection Strings:** Always use the **pooled** connection string for `DATABASE_URL` during application runtime to reuse connections in serverless environments. Always use the **direct (unpooled)** string for `DIRECT_DATABASE_URL` when applying migrations, because DDL migrations and lock operations bypass PgBouncer.
>
> _Note on Free Tiers:_ Neon free compute and Vercel Hobby plans are subject to provider quotas and terms (e.g. Neon scale-to-zero compute after inactivity and Vercel execution limits). Check current terms before relying on them.

---

## 4. Local Development & Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Apply migrations to your database

Generate and apply migrations using the direct connection string:

```bash
# Generate SQL migrations from schema changes
pnpm db:generate

# Apply migrations using drizzle-kit
pnpm drizzle-kit migrate
```

### 3. Seed demo data (optional)

To populate a demo user and starter categories:

```bash
pnpm db:seed
```

_Default demo account:_ `demo@pennywise.local` / `Password123!`

### 4. Run local development server

```bash
pnpm dev
```

The server will start with hot-reloading at `http://localhost:3000`.

---

## 5. Scripts & Testing

| Command             | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `pnpm dev`          | Start development server with `tsx watch`                    |
| `pnpm build`        | Compile TypeScript into `dist/`                              |
| `pnpm start`        | Run compiled production build from `dist/src/server.js`      |
| `pnpm test`         | Run all automated tests once with Vitest                     |
| `pnpm test:watch`   | Run tests in interactive watch mode                          |
| `pnpm lint`         | Run ESLint across the codebase                               |
| `pnpm format`       | Format code with Prettier                                    |
| `pnpm format:check` | Check code formatting without writing                        |
| `pnpm typecheck`    | Run TypeScript compiler type checking without emitting files |
| `pnpm db:generate`  | Generate Drizzle migrations from `src/db/schema.ts`          |
| `pnpm db:seed`      | Seed local database with demo workspace and categories       |

### Automated Testing Approach

Tests use **Vitest** and **Supertest** against an in-memory WebAssembly PostgreSQL database (`@electric-sql/pglite`). This runs real PostgreSQL migrations and queries with zero Docker or local installation required, providing fast, isolated test runs across any operating system.

---

## 6. Deployment to Vercel

The backend is configured for deployment on **Vercel Functions** using the Express bridge in `api/index.ts` and `vercel.json`.

### Deployment Steps:

1. Push your repository to your private GitHub / Git provider.
2. In the [Vercel Dashboard](https://vercel.com):
   - Import the project repository.
   - Set **Framework Preset** to `Other`.
   - Set **Root Directory** to `.` (or project root).
   - Ensure the build command is `pnpm build` and output directory is `dist`.
3. Configure **Environment Variables** in the Vercel project settings:
   - `NODE_ENV`: `production`
   - `DATABASE_URL`: Your pooled Neon connection string.
   - `DIRECT_DATABASE_URL`: Your unpooled Neon connection string.
   - `JWT_ACCESS_SECRET`: A high-entropy secret string (min 32 characters).
   - `JWT_ACCESS_EXPIRES_IN`: `900`
   - `REFRESH_TOKEN_EXPIRES_DAYS`: `30`
4. Deploy the project. Vercel routes all requests to `api/index.ts` via the rewrite rule in `vercel.json`.
5. Run migrations against your production Neon database from your local machine or CI pipeline:
   ```bash
   pnpm drizzle-kit migrate
   ```

---

## 7. API Specification

The REST API contract is specified in [`openapi.yaml`](file:///p:/Projects/pennywise/backend/openapi.yaml). The mobile application generates TypeScript client types directly from this file.

### Key Route Summary:

- **Health Check:** `GET /health`
- **Auth:**
  - `POST /auth/register` — Create account & initial workspace
  - `POST /auth/login` — Sign in & receive rotating tokens
  - `POST /auth/refresh` — Rotate refresh token
  - `POST /auth/logout` — Revoke refresh token
  - `GET /me` — Current user and workspace context
- **Categories:**
  - `GET /categories` — List categories with subcategories
  - `POST /categories` — Create category (with optional `addToMonth`)
  - `PATCH /categories/:id` — Rename, reorder, or archive category
  - `POST /categories/:id/subcategories` — Create subcategory
  - `PATCH /subcategories/:id` — Rename, reorder, or archive subcategory
- **Months & Lines:**
  - `GET /months` — List historical months
  - `POST /months` — Create month (with optional `copyFrom`)
  - `GET /months/:year/:month` — Full month view with totals
  - `POST /months/:year/:month/lines` — Add leaf line to month
  - `PATCH /budget-lines/:id` — Set or clear expected amount
  - `DELETE /budget-lines/:id` — Remove empty line from month
- **Transactions:**
  - `GET /budget-lines/:id/transactions` — List transactions on line
  - `POST /budget-lines/:id/transactions` — Record income or expense
  - `PATCH /transactions/:id` — Update amount or calendar date
  - `DELETE /transactions/:id` — Delete transaction
