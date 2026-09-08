# Architecture Review — Shuttlez .NET API → NestJS

## 1. Current Architecture

The source API is a **Clean Architecture / CQRS** ASP.NET Core 8 solution:

| Project | Role |
|---|---|
| `Shuttlez.API` | Controllers, middleware, SignalR hubs, Swagger |
| `Shuttlez.Application` | MediatR handlers, DTOs, validators, domain services |
| `Shuttlez.Domain` | Entities + enums |
| `Shuttlez.Infrastructure` | EF Core `AppDbContext`, JWT, OTP, Firebase, Google Maps, file storage |

There is **no classic repository layer**. Handlers talk to `IAppDbContext` (EF Core). Seat reservation uses atomic `ExecuteUpdate` plus PostgreSQL advisory locks and serializable transactions.

### Request flow

```
HTTP → ExceptionHandlingMiddleware → JWT (optional; global AllowAnonymous)
     → Controller (thin) → IMediator.Send
     → Handler / application service → AppDbContext → Neon PostgreSQL
```

Admin endpoints use `[AdminOnly]` (custom filter) because a global `AllowAnonymousFilter` disables standard `[Authorize]` for the mobile app.

### Authentication flow

1. OTP (4 digits, SHA-256 hex uppercase hash, 5 minutes, 5 attempts)
2. JWT HS256: issuer `Shuttlez`, audience `ShuttlezApp`
3. Claims: `sub`, `phone_number`, ASP.NET `nameidentifier`, `role` URI
4. Refresh tokens stored in `RefreshTokensSet` (64-byte Base64, 30 days, rotation)
5. Social login: Firebase ID token → Google/Facebook UID linking
6. Captain app (`client=driver|captain`) extra guard on login

### Database flow

EF Core + Npgsql, retry 3, command timeout 30s. Connection string SSL Mode rewritten to `Require` and Channel Binding disabled.

### External integrations

- Google Directions API (fallback straight-line polyline)
- Firebase Auth (social) + FCM push
- Local disk uploads (`wwwroot/uploads`, 16 MB driver documents)
- SignalR hubs: `/hubs/trip-tracking`, `/hubs/support-chat`, `/hubs/driver`

## 2. Project Structure (.NET)

```
src/Shuttlez.API/Controllers (+ Admin/)
src/Shuttlez.Application/{Auth,Users,Drivers,Trips,Bookings,Rides,Groups,...}
src/Shuttlez.Domain/Entities + Enums
src/Shuttlez.Infrastructure/Data/AppDbContext.cs
```

## 3–5. Controllers / Services / Repositories

See `API_INVENTORY.md`. Handlers **are** the services. Prisma `PrismaService` is the `IAppDbContext` equivalent, including seat SQL helpers.

## 6. Database

34 tables named `*Set` (EF DbSet convention), UUID PKs, `IsDeleted` soft delete, enums as **integers**. Full mapping: `DATABASE_MAPPING.md`.

No stored procedures. Advisory lock: `pg_advisory_xact_lock`.

## 7. Security

- No passwords (OTP + social)
- JWT HMAC-SHA256
- Roles: Passenger=1, Driver=2, Admin=3 (`UserType.ToString()` in JWT)
- AdminOnly checks role claim `Admin`
- Invalid JWT does **not** fail public routes (NoResult)

## 8. External Integrations

| Service | Config | Notes |
|---|---|---|
| Neon PostgreSQL | ConnectionStrings:DefaultConnection | Source of truth |
| Google Maps Directions | GoogleMaps:ApiKey | Optional fallback |
| Firebase Auth | Firebase:CredentialsPath | 503 if missing |
| FCM | same credentials | Push notifier |
| Redis | configured, unused in runtime DI | |

SMS is **not** integrated; OTP `debugCode` is returned to the client for local push.

## 9. Risks

See `RISKS.md`. Highest: JWT claim URIs, OTP hash casing, enum integers vs strings, global AllowAnonymous vs Nest guards, booking concurrency SQL, EF vs actual Neon schema until `prisma db pull` is compared.
