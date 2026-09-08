# Shuttlez API (NestJS)

Node.js + TypeScript migration of the existing ASP.NET Core Shuttlez API.

The **existing Neon PostgreSQL database is the source of truth**. This project does not create a new database, reset data, or run destructive Prisma migrations.

## Architecture

.NET:

`Controller → MediatR handler (business logic) → IAppDbContext / EF Core → Neon`

Node.js:

`Controller → Service (same business rules) → PrismaService → existing Neon PostgreSQL`

Controllers stay thin. JWT, OTP, error envelope, and route prefixes (`/api/v1/...`) match the .NET API so Flutter clients can keep working.

## Prerequisites

- Node.js 22+
- Access to the existing Neon `DATABASE_URL`

## Setup

```bash
cp .env.example .env
# fill DATABASE_URL and JWT_SECRET (same secret as .NET for token compatibility)
npm install
npx prisma generate
# Read-only introspection against Neon (never migrate reset / db push):
# npx prisma db pull
npm run build
npm run start:dev
```

Swagger UI: `http://localhost:3000/swagger`  
Health: `GET http://localhost:3000/api/v1/health`

## Database safety

- Uses `DATABASE_URL` from environment only
- `prisma db pull` is the supported introspection command
- Do **not** run `prisma migrate reset` or `prisma db push` against production

## Docker

The Dockerfile runs the API only. There is **no local Postgres container**. Pass the existing Neon URL:

```bash
docker compose up --build
```

## Docs

See `docs/` for architecture review, API inventory, database mapping, migration status, risks, and runbook.
