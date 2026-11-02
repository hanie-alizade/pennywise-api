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

| Variable                     | Description                                                                                                                                                                       | Example / Default                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | Application environment                                                                                                                                                           | `development` / `production` / `test`                                                 |
| `PORT`                       | Local dev server listening port                                                                                                                                                   | `3000`                                                                                |
| `DATABASE_URL`               | **POOLED connection string (PgBouncer with `-pooler` in hostname)**. Used by the app at runtime for connection pooling across serverless executions.                              | `postgresql://user:password@ep-sample-pooler.region.neon.tech/neondb?sslmode=require` |
| `DIRECT_DATABASE_URL`        | **DIRECT unpooled connection string (without `-pooler` in hostname)**. Used exclusively by `drizzle-kit` for schema migrations to bypass PgBouncer transaction/lock restrictions. | `postgresql://user:password@ep-sample.region.neon.tech/neondb?sslmode=require`        |
| `JWT_ACCESS_SECRET`          | Secret key for signing access JWTs (min 32 characters)                                                                                                                            | Secure random 256-bit string                                                          |
| `JWT_ACCESS_EXPIRES_IN`      | Access token lifetime in seconds                                                                                                                                                  | `900` (15 minutes)                                                                    |
| `REFRESH_TOKEN_EXPIRES_DAYS` | Refresh token lifetime in days                                                                                                                                                    | `30`                                                                                  |

> [!IMPORTANT]
> **Neon Connection Strings:** Always configure `DATABASE_URL` with the pooled connection string (`-pooler`) for production runtime on Vercel. Always configure `DIRECT_DATABASE_URL` with the direct (unpooled) connection string for applying Drizzle Kit schema migrations.
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

## 6. Deployment Guide (Neon & Vercel)

### Step 1: Provision Neon Database

1. Log in to [Neon](https://console.neon.tech).
2. Create a new project (e.g., `pennywise-prod`).
3. Under **Dashboard > Connection Details**:
   - Copy the **Pooled connection string** (contains `-pooler` in the host). This will be `DATABASE_URL`.
   - Copy the **Direct connection string** (uncheck "Connection pooling"). This will be `DIRECT_DATABASE_URL`.

### Step 2: Run Production Migrations

Run migrations against the production database using the direct connection string:

```powershell
$env:DIRECT_DATABASE_URL="postgresql://user:password@ep-sample.region.neon.tech/neondb?sslmode=require"
pnpm db:migrate
```

### Step 3: Deploy to Vercel

Vercel automatically detects Express applications with zero configuration when `src/app.ts` provides a default export (`export default app`). No custom `vercel.json` or `api/` directory is needed.

1. Push your repository to your private GitHub repo.
2. Go to the [Vercel Dashboard](https://vercel.com/new) and import the repository.
3. Configure the project settings:
   - **Framework Preset:** `Other` (or auto-detected Express)
   - **Root Directory:** `.`
   - **Build Command:** `pnpm build`
   - **Output Directory:** `dist`
4. Add the following **Environment Variables** in Vercel:
   - `NODE_ENV`: `production`
   - `DATABASE_URL`: _[Your Neon POOLED connection string]_
   - `DIRECT_DATABASE_URL`: _[Your Neon DIRECT connection string]_
   - `JWT_ACCESS_SECRET`: _[Random 32+ character string]_
   - `JWT_ACCESS_EXPIRES_IN`: `900`
   - `REFRESH_TOKEN_EXPIRES_DAYS`: `30`
5. Click **Deploy**.

---

## 7. Smoke Testing Production (PowerShell with `curl.exe`)

Once deployed, run these smoke tests from PowerShell against your deployment URL (replace `https://your-api.vercel.app` with your actual URL):

```powershell
$API_URL = "https://your-api.vercel.app"

# 1. Health check (should return 200 {"status":"ok"})
curl.exe -s -i "$API_URL/health"

# 2. Register account (creates user and personal workspace)
$regResponse = curl.exe -s -X POST "$API_URL/auth/register" `
  -H "Content-Type: application/json" `
  -d '{\"email\":\"testuser@example.com\",\"password\":\"StrongPassword123!\"}'

$regResponse
$TOKEN = ($regResponse | ConvertFrom-Json).accessToken

# 3. Authenticated /me check
curl.exe -s -H "Authorization: Bearer $TOKEN" "$API_URL/me"

# 4. Create category
$catResponse = curl.exe -s -X POST "$API_URL/categories" `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"Groceries\",\"type\":\"expense\"}'

$catResponse

# 5. Create month (e.g. 2026-11)
$monthResponse = curl.exe -s -X POST "$API_URL/months" `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{\"year\":2026,\"month\":11}'

$monthResponse

# 6. Verify 404 on nonexistent resource / cross-workspace isolation
curl.exe -s -i -H "Authorization: Bearer $TOKEN" "$API_URL/categories/00000000-0000-0000-0000-000000000000"
```

---

## 8. API Specification

The REST API contract is specified in [`openapi.yaml`](file:///p:/Projects/pennywise/backend/openapi.yaml). The mobile application generates TypeScript client types directly from this file.
