# Runbook

## Local

1. Copy `.env.example` → `.env`
2. Set `DATABASE_URL` to the **existing Neon** connection (sslmode=require)
3. Set `JWT_SECRET` / issuer / audience to match the .NET API if clients share tokens
4. `npm install`
5. `npx prisma generate`
6. Optional read-only: `npx prisma db pull` then inspect the diff. **Never** `migrate reset` or `db push` on production.
7. `npm run start:dev`
8. Check `GET /api/v1/health` and `/swagger`

## Production (Docker)

```bash
docker build -t shuttlez-api .
docker run --env-file .env -p 3000:3000 shuttlez-api
```

No Postgres container. The process must reach Neon over TLS.

## Dual-run with .NET

Both APIs can point at the same Neon database. Do not run booking-create traffic on both until seat SQL is fully ported and verified.

## Logs

Stdout (Nest logger). OTP codes log only when `NODE_ENV !== production` and `OTP_LOG_CODE_IN_DEVELOPMENT` is not `false`.

## Rollback

Point the reverse proxy / Flutter base URL back to the ASP.NET host. No database rollback is required if no schema was changed.
