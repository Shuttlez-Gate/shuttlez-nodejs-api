# Database mapping

Existing Neon PostgreSQL. Prisma schema maps EF PascalCase columns via `@map`.

| .NET Entity | PostgreSQL table | Prisma model | Node access |
|---|---|---|---|
| User | UsersSet | User | PrismaService.user / AuthService |
| OtpRequest | OtpRequestsSet | OtpRequest | OtpService |
| RefreshToken | RefreshTokensSet | RefreshToken | AuthService |
| SavedLocation | SavedLocationsSet | SavedLocation | SavedLocationsController |
| Driver | DriversSet | Driver | AuthService.register / LandingService |
| DriverDocument | DriverDocumentsSet | DriverDocument | pending drivers module |
| Vehicle | VehiclesSet | Vehicle | pending admin fleet |
| Route | RoutesSet | Route | RoutesController / LandingService |
| Stop | StopsSet | Stop | RoutesController |
| Trip | TripsSet | Trip | RemainingApiController + seat SQL |
| Booking | BookingsSet | Booking | RemainingApiController |
| Invoice | InvoicesSet | Invoice | RemainingApiController |
| Wallet | WalletsSet | Wallet | AuthService.register |
| WalletTransaction | WalletTransactionsSet | WalletTransaction | pending admin wallet |
| Review | ReviewsSet | Review | pending |
| Notification | NotificationsSet | Notification | NotificationsController |
| UserDevice | UserDevicesSet | UserDevice | NotificationsController |
| FaqItem | FaqItemsSet | FaqItem | ContentService |
| LegalDocument | LegalDocumentsSet | LegalDocument | ContentService |
| SupportTicket | SupportTicketsSet | SupportTicket | RemainingApiController |
| SupportMessage | SupportMessagesSet | SupportMessage | pending |
| RouteRequest | RouteRequestsSet | RouteRequest | pending |
| SubscriptionPackage | SubscriptionPackagesSet | SubscriptionPackage | RemainingApiController |
| LandingRouteLead | LandingRouteLeadsSet | LandingRouteLead | LandingService |
| LandingWaitlistEntry | LandingWaitlistEntriesSet | LandingWaitlistEntry | LandingService |
| LandingCaptainLead | LandingCaptainLeadsSet | LandingCaptainLead | LandingService |
| RouteDemandGroupState | RouteDemandGroupStatesSet | RouteDemandGroupState | pending admin demand |
| CommissionRule | CommissionRulesSet | CommissionRule | pending |
| PricingRule | PricingRulesSet | PricingRule | pending |
| RideFareRule | RideFareRulesSet | RideFareRule | RemainingApiController |
| GroupFareRule | GroupFareRulesSet | GroupFareRule | pending |
| RideRequest | RideRequestsSet | RideRequest | RemainingApiController |
| GroupRequest | GroupRequestsSet | GroupRequest | pending |
| GroupMember | GroupMembersSet | GroupMember | pending |
| (EF) | __EFMigrationsHistory | EfMigrationsHistory | unused |

Enums are integers in PostgreSQL (see `src/common/enums.ts`).

After `npx prisma db pull`, compare this file to the pulled schema. **If they differ, do not push changes to Neon — document the mismatch.**

## Introspection result (2026-09-08)

`npx prisma db pull` against the existing Neon `neondb` succeeded (35 models). Table names match EF `*Set` names.

### Documented mismatch (no schema change applied)

EF Core snapshot `Phase6N_CaptainRideLocation` includes on `RideRequestsSet`:

- `CaptainLatitude`
- `CaptainLongitude`
- `CaptainLocationUpdatedAt`

These columns were **not** present in the introspected Neon schema. The Node API must not assume they exist until the .NET migration is confirmed applied. Do **not** `prisma db push` to add them.

Filtered unique indexes on `UsersSet.GoogleProviderId` / `FacebookProviderId` may also appear as ordinary indexes after pull.

