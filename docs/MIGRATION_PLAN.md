# Migration plan

## Goals

Preserve API contracts, JWT, OTP, Neon schema, and business rules while moving the host to NestJS + Prisma + TypeScript.

## Output location

`E:\aa_MOC\Flutter_Projects\shuttlez-cursor-api-newnodejs`

(`G:\aa_MOC\Flutter_Projects\shuttlez-cursor-api-newnodejs` was requested; G: is a disconnected drive in this environment. The E: path is the accessible equivalent.)

## Phases

1. Review .NET architecture — done (`ARCHITECTURE_REVIEW.md`)
2. Preserve layering — controllers thin, services = handlers, Prisma = EF
3. API inventory — `API_INVENTORY.md`
4. Contract compatibility — same `/api/v1` routes and `ApiResponse` envelope
5. Business logic — Auth/OTP/JWT/content/landing/locations/notifications ported; bookings/rides/groups/demand still in progress
6. Authentication — Optional JWT + AdminOnly + ASP.NET claim URIs
7. Error handling — `AppExceptionFilter` camelCase envelope
8. External services — Firebase verifier + Google Maps config (service pending for polyline)
9. Project structure — Nest modules under `src/modules`
10. Tests — unit (phone/mapper) + health e2e
11. Swagger — `/swagger` Bearer
12. Environment — `.env.example`
13. Docker — API only, Neon URL
14. Docs — this folder
15. Status table — `MIGRATION_STATUS.md`
16. Build/validation — `npm install`, `prisma generate`, `npm test`, `npm run build`

## Next implementation slice (priority)

1. `prisma db pull` vs EF schema diff
2. Port `BookingHandlers` + seat SQL + commission/pricing resolvers
3. Port Ride + Group handlers and captain lifecycle
4. Port Admin route-demand launch (readiness calculator, advisory locks)
5. SignalR gateways
6. Contract tests against the live .NET API
