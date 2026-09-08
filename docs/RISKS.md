# Risks

1. **JWT claim URIs** — Flutter/.NET expect ASP.NET claim types (`nameidentifier`, `role`). Nest `JwtTokenService` emits the same URIs. Changing to short `role` only would break AdminOnly and CurrentUser.
2. **OTP hash casing** — .NET `Convert.ToHexString` is uppercase. Node must SHA-256 hex **uppercase** or existing OTPs fail (short-lived) and any future dual-run would mismatch.
3. **Optional JWT** — invalid tokens must not 401 public routes. `OptionalJwtGuard` mirrors `OnAuthenticationFailed = NoResult`.
4. **Enums** — stored as integers. Profile `userType` is a **string** (`passenger`). Mixing number/string in JSON will break Flutter.
5. **Booking concurrency** — seats use atomic UPDATE + serializable tx + `pg_advisory_xact_lock`. A naive Prisma `update` will oversell seats.
6. **EF vs Neon schema** — Prisma schema was generated from `AppDbContextModelSnapshot`, not yet compared with `prisma db pull`. A mismatch must be documented, never auto-pushed.
7. **Decimal** — money fields are `numeric`. Always use Prisma Decimal; do not use JS number for commission math.
8. **DateTime Kind** — .NET UTC timestamps with offset. Prisma DateTime is UTC; serialize ISO-8601.
9. **Global AllowAnonymous** — `[Authorize]` on Rides/Groups did not enforce MVC auth in .NET. Nest must not suddenly 401 those routes unless handlers already required a user.
10. **Refresh token rotation** — reuse of revoked tokens is rejected (`IsActive`).
11. **Captain login guard** — driver/captain clients cannot login unless UserType=Driver and Drivers.IsActive.
12. **Landing phone** — waitlist stores **digits only**, not E.164. Mixing `PhoneNormalizer` here would duplicate waitlist rows.
13. **Customer-trips** — must remain HTTP 410 + `CUSTOMER_TRIPS_DEPRECATED`.
14. **SignalR** — mobile captain polling vs hub; rate limit 12/min on GET driver trips.
15. **Firebase missing** — social endpoints return 503 `SOCIAL_AUTH_NOT_CONFIGURED` like .NET.
16. **G: output path** — drive not ready; code lives on E: equivalent folder.
