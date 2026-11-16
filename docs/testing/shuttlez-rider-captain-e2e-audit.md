# Shuttlez rider / captain integration audit

Date: 2026-10-27

This report is based on the code in the three repositories below. A feature is not marked verified just because a screen, DTO, or route name exists. Live app-to-database flows were not executed. There is no isolated test database in this workspace, and the existing `.env` was not opened.

## Repository inventory

| App | Path | Stack verified in repo |
| --- | --- | --- |
| Rider | `E:\aa_MOC\Flutter_Projects\shuttlez-cursor` | Flutter, GetIt, flutter_bloc, Dio, Firebase Auth including Facebook, FCM, Socket.IO |
| Captain | `E:\aa_MOC\Flutter_Projects\shuttlez-cursor-driver` | Flutter, GetIt, flutter_bloc, Dio, FCM, Socket.IO. Support chat still uses a SignalR client |
| Backend | `E:\aa_MOC\Flutter_Projects\shuttlez-cursor-api-newnodejs` | NestJS 11, Prisma 6, PostgreSQL, Socket.IO, Firebase Admin |

There is no global Nest prefix. Each controller declares `api/v1/...`. Realtime is Socket.IO, not ASP.NET SignalR, on these paths:

- `/hubs/driver`
- `/hubs/ride-tracking`
- `/hubs/trip-tracking`
- `/hubs/group`
- `/hubs/rider`
- `/hubs/support-chat`

Authentication is JWT (`JWT_SECRET`, issuer, audience). Facebook login remains `POST /api/v1/auth/social-login` with `provider: facebook` and a Firebase ID token. Rider UI still calls that path. It was not executed against Firebase in this audit.

Prisma models include `User`, `Driver`, `Vehicle`, `Route`, `Stop`, `Trip`, `Booking`, `Invoice`, `RideRequest`, `GroupRequest`, `GroupMember`, `TripSegmentInventory`, `CancellationRequest`, `RideFareRule`, `GroupFareRule`, `PricingRule`, and `Wallet`. Domain statuses are TypeScript constants in `src/common/enums.ts`, not Prisma enums. `prisma/migrations` is not in the repo. The schema header says it was introspected from the existing database. `EfMigrationsHistory` is mapped, but migration names were not queried.

## Feature matrix

| Feature | Rider UI | Captain UI | Backend API | Database | Realtime | Automated tests | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Private ride create, quote, cancel before start | `ConfirmBookingPage`, `POST /api/v1/rides` | Incoming sheet, accept, arrive, start, complete, cancel | `rides.controller.ts`, `drivers.controller.ts` | `RideRequest` | `/hubs/ride-tracking`, `/hubs/driver` | Policy unit tests. No HTTP/DB run | Implemented but unverified | Fare is computed on the server in `RidesService.create`. Client fare is not stored |
| Private ride acceptance | Searching page polls and listens for `RideAccepted` | `POST /api/v1/drivers/me/rides/:id/accept` | Conditional `updateMany` added in this audit | `driverId` + `status` | `RideRequestClaimed`, `RideAccepted` | `decideRideAccept` unit tests. No concurrent DB run | Implemented but unverified | Previous unconditional `update` could rewind a finished ride and lose a concurrent claim |
| Captain availability | Not applicable | Online toggle now calls `POST /api/v1/drivers/me/availability` and still stores a local preference | `DriversService.setAvailability` writes `Driver.isOnline` | `Driver.isOnline` | Socket presence is separate from the flag | Endpoint string test only | Implemented but unverified | Before this change the toggle never left the device, while pending rides required `isOnline` |
| Captain eligibility | Not applicable | Client also filters 5 km and 5 minutes | `ride-offer-policy.ts` used by pending rides, accept, and driver broadcast | Active `Trip`, `GroupRequest`, `RideRequest` | Broadcast no longer falls back to every connected captain | Truth-table unit tests | Implemented but unverified | Distance on accept is checked only when this process still has a fresh presence |
| Group ride (`group_car`) | Home card books through the rides API with `requestedVehicleKind` | Same marketplace ride flow | Stored on `RideRequest.requestedVehicleKind` | Same table as a private ride | Same ride hubs | Vehicle-family unit test | Partially implemented | This is a vehicle kind, not a separate shared-seat model |
| Group trip (charter / invite) | Create, join, leave, confirm, cancel under `/api/v1/groups` | Assigned jobs can start and complete. No in-app accept | Join uses a transaction and `joinedMemberCount` guard. Assignment is admin-only | `GroupRequest`, `GroupMember` | `/hubs/group` | Existing group capacity code. No new DB test | Partially implemented | No captain self-accept endpoint exists |
| Scooter | Home card sends `vehicleKind: scooter`. Map car-type sheet still shows coming soon | Incoming sheet understands scooter. Same ride endpoints | `VehicleType.Scooter = 4`. No scooter inventory table | Kind on the ride row | Same ride hubs | Vehicle mismatch unit test | Partially implemented | Scooter is an on-demand ride kind. It is not a dockless vehicle assignment |
| Shuttle seat booking | Booking preview and `POST /api/v1/bookings` | Live trip start/complete | Booking transaction decrements seats | `Trip`, `Booking`, `TripSegmentInventory` | `/hubs/trip-tracking` | Existing segment and history unit tests. No booking HTTP run | Implemented but unverified | `BookingStatus.Expired` has no writer |
| Captain routes | Lists `GET /api/v1/routes/captain` and books a seat | CRUD, publish, share, schedule | `CaptainRoutesController` under `/api/v1/drivers/me` | `Route.ownerDriverId`, generated `Trip` rows | Trip hub after a trip exists | `recurrence.spec.ts` plus captain widget tests. No route generation against PostgreSQL | Implemented but unverified | Client paths match the controller. `daily` is stored as weekly with all seven days |
| Payments, refunds, cancellation fees | Cash and subscription credit copy | Cash collect on a ride | `requireCash`. Invoice stays pending. No card capture | `Invoice`, `Wallet` | `FareCollected` event | Commission snapshot unit test | Partially implemented | No refund service and no cancellation fee. Wallet credit is an admin action |
| Facebook login | `signInWithFacebook` then social-login | Not the captain login path | `POST /api/v1/auth/social-login` | `User.facebookProviderId` | Not applicable | Rider unit test mocks the SDK | Implemented but unverified | Not executed against Firebase |
| FCM | Registers `POST /api/v1/notifications/devices` | Same path. Unused constant `registerDevice` still points at `/api/v1/auth/register-device` | `notifications.controller.ts` | `UserDevice` | Push is not the ride source of truth | Path unit tests | Implemented but unverified | No Firebase credentials were used |
| Database integration | Not applicable | Not applicable | Jest unit tests do not open Prisma | PostgreSQL expected | Not applicable | Blocked | Blocked by environment | No `TEST_DATABASE_URL`, no migration directory, `.env` not read |

## Trip lifecycle

### On-demand ride (`RideRequest`)

Statuses: `Requested 1`, `Assigned 2`, `InProgress 3`, `Completed 4`, `Cancelled 5`.

| From | To | Actor | Rule in code |
| --- | --- | --- | --- |
| none | Requested | Rider | `RidesService.create`. Server calculates fare. Cash or subscription only |
| Requested, unassigned | Assigned | Assigned captain | One conditional update. A second captain is rejected. The same captain can retry |
| Assigned, same captain | Assigned | Same captain | Idempotent success. Status is not rewritten |
| Assigned | Requested, unassigned | Assigned captain | Release, then the ride is broadcast again |
| Assigned | InProgress | Assigned captain | Start. Arrival is not required |
| Assigned or InProgress | Completed | Assigned captain | Complete from Assigned is allowed by the existing code. This audit did not change that |
| Requested or Assigned | Cancelled | Owning rider | In-progress and completed rides cannot be cancelled by the rider |
| InProgress | Completed | Assigned captain, with the other party | Early termination. The driver handler now requires the assigned captain |

Arrival is not a database status. `arrive` checks `Assigned`, touches `updatedAt`, and emits `CaptainArrivalConfirmed`. The arrived set lives in process memory.

Invalid claims now rejected by `decideRideAccept`: cancelled, completed, in progress, assigned to someone else, and any unknown status. Those paths do not write a new status.

### Shuttle trip (`Trip`)

Statuses: `Scheduled 1`, `DriverAssigned 2`, `InProgress 3`, `Completed 4`, `Cancelled 5`.

Captain start allows `Scheduled` or `DriverAssigned`. Complete allows only `InProgress`. Repeating start or complete returns `idempotent: true`. Rider cancellation is `POST /api/v1/trips/:id/cancel` and restores seats. There is no captain “accept shuttle” call. The captain is the trip’s `driverId`, set by admin assignment or by captain-route generation.

### Group trip (`GroupRequest`)

Statuses: `Draft 1`, `Confirmed 2`, `Assigned 3`, `InProgress 4`, `Completed 5`, `Cancelled 6`.

Organizer confirms a draft. Joining is limited to `Draft`, blocks duplicates, and increments `joinedMemberCount` only when it is still below capacity. Captain start allows `Assigned` or `Confirmed`. Complete allows only `InProgress`. A captain cannot accept a group through the driver API. Admin assignment is `PUT /api/v1/admin/groups/:groupId/driver`.

### Scooter

No separate state machine. A scooter request is a `RideRequest` with `requestedVehicleKind = scooter`. The same accept, start, and complete rules apply. A captain whose vehicle family is car is no longer offered a scooter request when both families are known.

### Captain routes

`RecurrenceKind`: `Once 0`, `Weekly 1`, `DateRange 2`. `daily` and `specific-days` parse as weekly. Generated trips keep `routeId` and are created with the owning captain. Seat capacity for captain-route trips uses segment inventory. This was read from `captain-routes.service.ts` and `recurrence.spec.ts`. Generation was not executed.

## Scenario checklist

| ID | Category | Result |
| --- | --- | --- |
| C1 | Private ride happy path and invalid transitions | Rules reconstructed and the accept decision is unit-tested. Create, notify, and history were not run against a server |
| C1-concurrency | Two captains accept one request | Code uses one `updateMany` guarded by `status = Requested` and `driverId is null or self`. Not executed against PostgreSQL |
| C2 | Group ride as `group_car` | Same ride pipeline. Seat capacity does not apply. Concurrent last-seat behavior is not applicable to this model |
| C3 | Scooter | Supported only as a ride vehicle kind. No scooter inventory, so concurrent booking of one physical scooter is not applicable |
| C4 | Shuttle | Booking lock and seat decrement exist. Full, departed, and timezone cases were not executed |
| C5 | Group trip | Membership transaction exists. Invite expiry, revocation, and realtime fan-out were not executed. No captain accept API |
| C6 | Captain routes | Endpoint contract matches the captain client. Recurrence parsing is unit-tested. Trip generation was not executed |

## Captain eligibility truth table

Radius default is 5 km, capped at 10 km. The near-completion rule is an in-progress ride whose estimated remaining time is 5 minutes or less. ETA uses 2.5 minutes per kilometre from the current location to the destination, or elapsed time against the stored trip distance when a live location is missing. An assigned ride that has not started blocks every new offer. Unknown ETA on an in-progress ride blocks the offer.

| Case | Visible | Actionable on the server | Reason |
| --- | --- | --- | --- |
| 1. No current trip, pickup within radius, online, active | Yes | Yes | `eligible` |
| 2. No current trip, pickup beyond radius | No | No | `pickup_too_far` |
| 3. In-progress ride with more than 5 minutes left | No | No | `ride_not_finishing` |
| 4. About 5 minutes left and the current destination is near the new pickup | Yes | Yes | Distance is measured from the current destination |
| 5. Almost completed, remaining time 0 to 5 minutes | Yes | Yes | Same rule as case 4 |
| 6. Current ride already completed | Yes, if nearby and online | Yes | It is no longer an active ride |
| 7. Current ride cancelled | Yes, if nearby and online | Yes | Same as case 6 |
| 8. Captain offline or inactive | No | No | `offline` or `inactive` |
| 9. Stored socket location older than 15 minutes | No | Accept is rejected when this process still holds that presence | `stale_location` |
| 10. Several captains inside the radius | Each matching captain | The first successful conditional update wins | Far captains are omitted. There is no broadcast to the whole online room |

These rows are asserted in `src/modules/drivers/ride-offer-policy.spec.ts`.

## API contract notes

| Client | Backend | Result |
| --- | --- | --- |
| Captain `POST /api/v1/drivers/me/availability` | Added in this audit | New contract. The captain app calls it from the online toggle |
| Captain route CRUD and `POST /api/v1/drivers/me/trips` | `CaptainRoutesController` | Paths match |
| Captain FCM `POST /api/v1/notifications/devices` | `notifications.controller.ts` | Live path matches. Unused constant `/api/v1/auth/register-device` does not exist |
| Rider and captain `/hubs/driver`, `/hubs/ride-tracking`, `/hubs/trip-tracking` | Socket.IO gateways | Paths match. Identity is now a verified JWT |
| `POST /api/v1/customer-trips` | Returns 410 | Rider does not call it |

## Confirmed defects

### Fixed in this audit

| ID | Severity | Defect | Correction |
| --- | --- | --- | --- |
| D1 | P0 | `acceptRide` wrote `Assigned` even when the ride was completed, in progress, or won by the other captain | Claim only a `Requested` row with `updateMany`. Terminal states are rejected. Same-captain retry is idempotent |
| D2 | P0 | `/hubs/driver` trusted `userId` or an unsigned JWT payload, and could join the online room as another captain | Signature, issuer, audience, and expiry are verified. A mismatched claimed user id is rejected |
| D3 | P0 | `/hubs/ride-tracking` preferred a client-supplied user id and decoded unverified payloads | Join requires the verified token subject |
| D4 | P0 | `/hubs/trip-tracking` joined any caller and accepted location broadcasts from anyone | Join requires a verified rider booking or the assigned captain. Broadcasts require the assigned captain. The captain client now sends its access token |
| D5 | P0 | Driver early termination did not check that the caller owned the ride | `requireDriver` plus `ride.driverId` check |
| D6 | P1 | Pending rides required `Driver.isOnline`, but the captain toggle only wrote SharedPreferences | `POST /api/v1/drivers/me/availability` persists the flag, and accept rejects an offline captain |
| D7 | P1 | A captain with an active shuttle, group, or ride could still accept another ride | Accept uses the same workload rule as the pending list |
| D8 | P1 | Pending offers hardcoded `vehicleKind: car`, and a far captain received the public socket fallback | Offers keep `requestedVehicleKind`. Broadcast goes only to fresh, in-range, compatible presences |
| D9 | P1 | Socket location was sent mainly at connect, so a later freshness check would have gone stale | While online, the captain app publishes location on the existing 15 second interval |

### Not changed

| ID | Severity | Item | Why it remains |
| --- | --- | --- | --- |
| R1 | P1 | Complete is allowed from `Assigned` without start | Existing server rule. Changing it would reject a path the API currently documents as success |
| R2 | P1 | Arrival is memory-only and is not required before start | No arrival column exists. A new status was not invented |
| R3 | P1 | Group trips have no captain accept | Admin assignment is the implemented path |
| R4 | P2 | Ride `timeoutSeconds: 30` and the 15 minute pending window do not cancel the row | No expiry job exists. `BookingStatus.Expired` is also unused |
| R5 | P2 | Reject does not persist | The handler only returns an acknowledgement |
| R6 | P2 | Accept distance is skipped when this process has no presence | Presence is in memory. A second instance cannot see it. A missing presence is not treated as a nearby location |
| R7 | P2 | Socket `hasActiveRide` is still reported by the client | Accept rechecks the database. The sheet can still appear early |
| R8 | P3 | Rider map flow marks scooter coming soon while home can book it | Product copy inconsistency. UI was not redesigned |
| R9 | P3 | Female-driver toggle is not sent to `POST /api/v1/rides` | No backend field supports it |

## Fixes and regression coverage

Automated regression for the policy is `src/modules/drivers/ride-offer-policy.spec.ts` (21 tests). It covers the truth table, invalid accept transitions, vehicle family, missing pickup coordinates, and forged socket identity.

Captain `test/phase4b_captain_lifecycle_test.dart` asserts the new availability path. That file, together with `test/api_dedup_and_realtime_test.dart`, passed: 10 tests.

The service and gateway changes are not covered by an HTTP test. They require a database and a running Socket.IO server.

## Test execution

| Command | Working directory | Result |
| --- | --- | --- |
| `npm test -- --colors=false` | backend | Pass. 24 suites, 188 tests |
| `npm run test:e2e -- --colors=false` | backend | Pass. 1 test. Health controller only. No database |
| `npx tsc --noEmit --pretty false` | backend | Pass |
| `flutter test test/phase4b_captain_lifecycle_test.dart test/api_dedup_and_realtime_test.dart` | captain | Pass. 10 tests. Flutter reported it could not reach GitHub and that the SDK is old. The tests still ran |
| `flutter test` | captain | First run this audit: 26 passed, 8 failed. After the continuation below: see the continuation test table. Not an app-to-backend run |
| Rider `flutter test` | rider | Not run. No rider file was changed |
| Backend integration against PostgreSQL | backend | Not run. Blocked |

ESLint on the touched backend files still reports pre-existing `any` types in ride-tracking handlers that this change did not rewrite. The new accept and driver-presence paths were typed without `any`.

## Blocked tests and missing dependencies

- No `TEST_DATABASE_URL` in `.env.example`. The real `DATABASE_URL` was not read and was not used.
- No `prisma/migrations` directory, so a disposable database cannot be migrated from this repo.
- Firebase credentials, FCM delivery, and Facebook login were not exercised.
- No device or emulator ride was created. Socket.IO was not connected to a running API.
- Flutter’s `fetch --tags` failed because `github.com:443` was unreachable from this machine. Local tests still started.

## How to run the tests again

From the backend repository:

```bash
npm test
npx tsc --noEmit
npm run test:e2e
```

`npm test` does not open PostgreSQL. `test:e2e` only constructs the health controller.

From the captain repository:

```bash
flutter test test/phase4b_captain_lifecycle_test.dart test/api_dedup_and_realtime_test.dart
```

Do not point these tests at production. An integration suite needs a separate empty PostgreSQL database, a `TEST_DATABASE_URL` that is not the production URL, and a decision about how to create the schema without a migration directory. That work was intentionally not started.

## Remaining risks

The backend row is authoritative for accept, but this audit did not watch a rider and a captain complete one ride. Concurrent accept, seat capacity, and scheduled-trip generation are protected in code by conditional updates or transactions, and those statements were not run under concurrency.

Captain online status and the API must be deployed together. An old captain build can still receive a socket offer, then receive 403 on accept if `isOnline` is false.

Location freshness uses the existing 15 minute ride-request window. A captain build that does not send the new heartbeat will stop receiving targeted offers after that window even if the socket stays connected.

Group trips, shuttle bookings, refunds, and Facebook login remain code-reviewed only.

## Continuation — 2026-10-27

This pass started from the report above and the dirty captain working tree. Unrelated captain UI changes were left in place. No commit was created. `.env` was not opened, printed, or copied.

### Task 1 — Captain test failures

The first full suite failed to load three files and failed five widget tests. After those files compiled, more assertions in the same files failed. None were fixed by deleting a test or dropping the behavior it checked.

| Failure | Cause | Correction |
| --- | --- | --- |
| `waitSeconds`, `bannerText`, `noticeText` on `TripWaitingSheet` | Outdated test. The start sheet now takes `title`, `timeLabel`, and `onStart`. Cancel and the countdown remain on `TripRidersSheet` | Tests assert the current start sheet and keep the cancel assertion on `TripRidersSheet` |
| `title` and `subtitle` on `TripCompletedSheet` | Outdated test. The sheet renders `allDropoffsDone` and finishes through `SlideConfirmButton` | Tests assert `تم انهاء جميع نقاط الوصول` and require a completed slide to call `onFinish` |
| `driverName` on `RideReceiptSheet.show` | Outdated test. The parameter is `customerName`. The receipt content is unchanged | The test passes `customerName` and still expects the fare and collection actions |
| Profile delete-account and stop-shuttles tests | Production layout bug. The support row at `driver_profile_page.dart` overflowed by 95px on a narrow card | The label is `Flexible` and ellipsized. The dialog assertions were not changed |
| Rating submit looked for `ElevatedButton` | The control is a `GestureDetector`, and it submitted with zero stars | Submit stays disabled until a star is selected. The test still requires `onTap` to be null, then non-null |
| Live-trip start copy and the following phase | The slide label is `تأكيد بدء الرحلة`. Confirm stays disabled until each rider’s board checkbox is set. The sheet column overflowed, so the slide target was not hit. Opening the trip hub without a token left a reconnect timer | Tests use the current label, mark the real checkboxes, and still require the next pickup and drop-off phases. The sheet scrolls. The trip hub does not connect without an access token |
| `pumpAndSettle` on sheets that contain `SlideConfirmButton` | The button’s hint animation repeats, so settle never finishes | Those tests pump a bounded frame. The animation was not removed |

### Task 2 — PostgreSQL

No isolated database was created or contacted.

Checked on this machine, without reading secrets:

- `docker` is not installed.
- `psql` and `postgres` are not on `PATH`.
- No `postgres.exe` was found under `C:\Program Files` or `C:\Program Files (x86)`.
- No PostgreSQL Windows service was registered.
- `127.0.0.1:5432` refused a connection (`TcpTestSucceeded = False`).
- `DATABASE_URL` and `TEST_DATABASE_URL` are unset in the process environment.

`prisma/migrations` is absent because `prisma/schema.prisma` was produced by `prisma db pull` from an existing database. The files in `prisma/sql/` are additive `ALTER TABLE` scripts. They say to run them manually against the existing database and not to `db push` or `migrate reset` production. They cannot create an empty database, because they alter tables such as `RoutesSet` that must already exist.

Safe initialization, once a new empty local database exists and its URL is known to be that database only: point `TEST_DATABASE_URL` at it, confirm the database is empty, then apply `prisma db push` from `schema.prisma` to that URL alone. Do not run `prisma/sql` until those base tables exist. Do not point that command at a database whose origin is unknown. That step was not run.

### Task 3 — Acceptance and identity

The ten rules are still covered only by the pure unit tests in `src/modules/drivers/ride-offer-policy.spec.ts` from the earlier run (21 tests). That file does not open PostgreSQL and does not run two transactions at once. It is not evidence of database-level concurrency safety. No new database test was executed in this pass.

### Task 4 — API contracts

Compared the captain and rider endpoint constants and socket clients with the Nest controllers and `realtime.gateway.ts`. No live HTTP call was accepted by a test backend. Widget tests that fell through to `http://10.0.2.2:3000` received HTTP 400 and then used local catalog data. That is not a contract execution.

Paths that match the controllers:

- Captain ride list, pending rides, availability, accept, reject, arrive, start, complete, collect, cancel, terminate, and location.
- Captain shuttle trip start, complete, and cancel under `/api/v1/drivers/me/trips/:tripId`.
- Captain route list, seat quote, publish, toggle, share, and cancellation request.
- Captain group start and complete. There is still no captain accept for a `GroupRequest`.
- Rider rides, groups, bookings, and `POST /api/v1/notifications/devices`.
- Auth OTP, register, refresh, logout, and rider `POST /api/v1/auth/social-login`.

The three ride hubs do not share events.

| Hub | Client events | Server events used by that client |
| --- | --- | --- |
| `/hubs/driver` | `JoinDriverRoom`, `UpdateDriverLocation` | `NewRideRequest`, `RideRequestClaimed`, `TripsChanged` |
| `/hubs/ride-tracking` | `JoinRide`, `LeaveRide`, `BroadcastCaptainLocation`, `ConfirmArrival`, `RequestTermination`, `ResolveTermination` | `JoinRideAcknowledged`, `RideStateSync`, `RideAccepted`, `CaptainLocationUpdated`, `CaptainArrivalConfirmed`, `RideStarted`, `RideCompleted`, `FareCollected`, `RideCancelled`, `RideTerminationRequested`, `RideTerminationResolved` |
| `/hubs/trip-tracking` | `JoinTrip`, `BroadcastDriverLocation`, `BroadcastTripProgress` | `TripChatMessage`, `TripProgressUpdated` |

Incompatible contract left unchanged:

- Captain support chat still uses the SignalR client and listens for `MessageReceived`.
- The API and the rider app use Socket.IO on `/hubs/support-chat` and the event `SupportMessageCreated`.

Unused captain constants, not called from the app code that was searched:

- `ApiEndpoints.registerDevice` points at `/api/v1/auth/register-device`, which has no controller. The live registration path is `POST /api/v1/notifications/devices`.
- `adminResetDeviceByPhone` and `adminResetDeviceByDriverId` have no matching controller.

`POST /api/v1/customer-trips` still returns 410. The rider constant exists and was not found at a call site.

### Task 5 and Task 6 — Cross-application and realtime scenarios

Not executed. There is no isolated API process and no verified test database. No emulator or device session was driven. Polling was not used as a substitute.

| Scenario | Result |
| --- | --- |
| A. Private ride across rider and captain | Blocked |
| B. `group_car` and scooter ride requests | Blocked. Code review only: both are `RideRequest.requestedVehicleKind` |
| C. Shuttle booking and seat release | Blocked |
| D. Group trip membership and admin assignment | Blocked. Code review only: no captain accept route; assignment is `PUT /api/v1/admin/groups/:groupId/driver` |
| E. Captain route generation and booking | Blocked |
| Socket connect, accept fan-out, authorized location, reconnect, duplicates, restart, late events | Blocked |

Captain widget tests do exercise the live-trip sheet against catalog data after the network call fails. That is a widget test, not a mobile end-to-end test.

### Task 7 — Facebook and FCM

No provider credentials and no device were used. No notification was sent.

| Check | What actually ran | Status |
| --- | --- | --- |
| Captain `test/phase4c_fcm_test.dart` | Asserts the device path string and two type names | Unit test. Not a push delivery |
| Rider `test/social_auth_facebook_test.dart` | Present in the rider repo. It uses a fake identity and a fake API. It was not executed in this pass | Mocked unit test, not executed here |

Manual procedure, not performed:

1. Use a Firebase test project and a test Facebook app. Do not use a customer account.
2. On a rider build pointed at the isolated API, sign in with Facebook and confirm `POST /api/v1/auth/social-login` stores `facebookProviderId` on a test user.
3. Register an FCM token with `POST /api/v1/notifications/devices` from a test build.
4. Send one notification through the test Firebase project to that token only.
5. Confirm the captain or rider shows it, then delete the test device row.

### Task 8 — Commands and counts

| Command | Directory | Result |
| --- | --- | --- |
| `flutter test test/captain_route_lifecycle_test.dart test/group_trip_lifecycle_test.dart test/individual_trip_lifecycle_test.dart test/screens_test.dart test/driver_profile_page_test.dart` | captain | Used while fixing. The last isolated live-trip test passed before the full suite |
| `flutter test` | captain | Pass. 47 tests, 0 failed, exit code 0. Widget and unit tests only. Several live-trip cases call `http://10.0.2.2:3000` and receive HTTP 400, then continue on local catalog data |
| `flutter analyze` | captain | Pass. `No issues found` after the last edit |

Backend `npm test` was not repeated in this pass. The earlier result remains 24 suites and 188 unit tests, plus one health e2e test that does not open a database.

### What this continuation does not prove

- Two captains cannot both commit the same ride in PostgreSQL.
- A completed ride cannot be reopened by a real `UPDATE`.
- Socket.IO rejects an invalid JWT on a running server.
- Rider and captain apps complete any of the five trip scenarios against one database.
- Facebook login or FCM delivery works.

## Continuation — support chat and database availability

### Support chat root cause

SignalR is not an active support service. The only backend mention of SignalR is a rate-limit string. Support chat is Socket.IO on `/hubs/support-chat`.

The conversation is not between a rider and a captain. A ticket belongs to one user. That user, rider or captain, sends with `POST /api/v1/support/tickets/:id/messages`. A staff reply is `POST /api/v1/admin/support/tickets/:id/messages` with `isFromSupport: true`. Both writes are stored in `SupportMessage` before `SupportChatGateway.publish` emits `SupportMessageCreated` to room `ticket-{id}`.

The payload is `id`, `ticketId`, `isFromSupport`, `content`, and `createdAt`. There is no socket acknowledgement and no sender id on the event. History is `GET /api/v1/support/tickets/:id/messages`, not a socket replay. Join requires a verified JWT (`SocketIdentity`: secret, issuer `Shuttlez`, audience `ShuttlezApp`) and `SupportTicket.userId` equal to that subject. A socket event cannot create a message. `LeaveTicket` also requires a verified user.

The Captain screen already sent on that REST path. It listened with SignalR for `MessageReceived`, so staff replies could not arrive. The client now uses the same Socket.IO path, auth token, `JoinTicket`, `LeaveTicket`, and `SupportMessageCreated` event. It does not connect without an access token, rejoins the current ticket after reconnect, ignores another ticket's payload, and drops a repeated message id. The Captain UI still shows only `isFromSupport` messages, so the owner's own REST echo is not appended twice.

Delivering a rider ticket to a captain would break the ownership check. That behavior was not added.

### Support chat tests

These are a live Socket.IO test with mocked Prisma, plus a Captain unit test of the payload rules. They are not a PostgreSQL test and not a mobile end-to-end test.

| Command | Directory | Exit | Result |
| --- | --- | --- | --- |
| `npx jest src/modules/realtime/support-chat.gateway.spec.ts --colors=false --detectOpenHandles` | backend | 0 | 3 passed |
| `flutter test test/support_chat_protocol_test.dart` | captain | 0 | 5 passed |
| `npx tsc --noEmit --pretty false` | backend | 0 | Pass |
| `flutter analyze` | captain | 0 | No issues |

What the socket test checked:

- A staff reply on the captain's ticket reaches only the captain socket, with the persisted fields.
- The rider socket, joined to a different ticket, does not receive it.
- A captain token, an invalid JWT, and a missing token cannot join the rider's room. Emitting `SendMessage` does not publish anything.
- A message published while the owner is disconnected is not replayed after join.
- After reconnect, one new message arrives once.

The Flutter test checks payload parsing, staff versus user, empty payloads, cross-ticket filtering, and duplicate ids. Message history and REST errors were not executed against a server.

### PostgreSQL

The checks below were true when this section was written. They are superseded by "Continuation — isolated PostgreSQL".

Still blocked at that time. This pass rechecked the machine:

- `TEST_DATABASE_URL` and `DATABASE_URL` are unset. `.env` was not opened.
- `127.0.0.1:5432` refused the connection.
- No approved managed test instance is configured in the repo. `package.json` has `prisma:pull` and `prisma:generate` only. Prisma is 6.16.1.
- `prisma/schema.prisma` is a `db pull` of an existing PostgreSQL database. `prisma/sql/` only alters tables that already exist.

No database was created, migrated, or queried. `prisma db push` was not run. Concurrency tests and the six ride workflows were not executed.

### Six trip categories

| Workflow | Result |
| --- | --- |
| A. Individual car | Blocked. No isolated API or database |
| B. Group car as a ride request | Blocked. Code review only |
| C. Scooter ride | Blocked. Code review only |
| D. Shuttle booking | Blocked |
| E. GroupRequest admin assignment | Blocked |
| F. Captain routes | Blocked |

No mobile device or UI automation was run. None of these is an API end-to-end pass.

### Still blocked

- Real PostgreSQL concurrency: two accepts, accept versus cancel or complete, duplicate booking, seat capacity, trip generation, and rollback.
- Socket.IO ride acceptance between a rider and a captain on a running API.
- Mobile-to-mobile rides.
- Facebook login and FCM delivery.
- Support-message rows written and read back from PostgreSQL.

The concurrency and support-message items above were executed later against the isolated database. See "Continuation — isolated PostgreSQL". Mobile rides, Facebook, and FCM remain unexecuted.

## Continuation — isolated PostgreSQL

This pass used a user-space PostgreSQL 18.4 process. The Windows account is not an administrator, so a system PostgreSQL service was not installed. `127.0.0.1:5432` was not used. No production database was opened, and no migration history was created.

### Database setup

`scripts/start-integration-postgres.mjs` starts embedded PostgreSQL with a data directory under `.local/pg-test`, which is gitignored. The server listens on `127.0.0.1:54329`. The database name is `shuttlez_integration_test`. The password and connection string stay in that gitignored directory and are not recorded here.

The first cluster used encoding `WIN1252`, so an Arabic support message failed with PostgreSQL `22P05`. After confirming the connection was `shuttlez_integration_test` on port `54329`, `scripts/recreate-test-db-utf8.mjs` dropped and recreated only that database as `UTF8` (`LC_COLLATE C`, `LC_CTYPE C`, `template0`). A disposable Arabic row was inserted and its table was dropped. `scripts/check-test-db-encoding.mjs` then reported:

- database `shuttlez_integration_test`
- port `54329`
- server, client, and database encoding `UTF8`
- 39 tables, 0 enum types, 41 foreign keys, 105 indexes

The Prisma schema has no Postgres enum types and no PostGIS extension. Status values are integers in application code. `prisma/sql/` was not applied: those scripts alter tables that already exist. On the empty database, `prisma db push --skip-generate` created the schema. Prisma logged that it loaded `.env`, and its datasource line named `shuttlez_integration_test` at `127.0.0.1:54329`.

`node scripts/recreate-test-db-utf8.mjs` exited 0. `node scripts/check-test-db-encoding.mjs` exited 0.

### Application boot

The integration file starts the Nest application with `DATABASE_URL` set to the isolated database before boot. `PrismaService` connected. `current_database()` was `shuttlez_integration_test` and `inet_server_port()` was `54329`. `GET /api/v1/health` returned HTTP 200 with `success: true` and `data.status: healthy`. This is an API process boot, not a Rider or Captain mobile session.

### Integration results

Command:

```bash
npx jest src/modules/drivers/postgres-integration.spec.ts --runInBand --testTimeout 120000
```

Result: exit code 1. 13 passed, 1 failed, 14 total. The same command is `npm run test:integration`. It is excluded from `npm test` because it requires this local database.

These tests call the real services and persist rows. They are not mocked policy tests and they are not mobile end-to-end tests. Seat-full marking and group publish were stubbed after the database write, as noted below.

| Check | Result |
| --- | --- |
| Two captains accept one ride | Passed. Exactly one call succeeded. The row stayed `Assigned` with one of the two driver ids |
| Same captain accepts twice, including two overlapping calls | Passed. One `Assigned` row remained |
| Accept racing rider cancel | Passed. The single row was `Assigned` or `Cancelled`. Rider cancel of an assigned ride is allowed by the current service, and that cancel is an unconditional update |
| Accept racing complete, then complete after accept | Passed. A completed row belonged to the accepting captain. A later accept did not reopen it |
| Availability and offer eligibility | Passed. An offline captain received no nearby offers and could not accept. After going online, a nearby `group_car` request was visible and a far coordinate was not |
| Last shuttle seat and duplicate booking | Passed. One booking remained, `availableSeats` became 0, and the extra booking was rejected. `markTripFullIfNeeded` was stubbed because the test client is not `PrismaService` |
| Sequential trip generation | Passed. The second call returned count 0 and one trip row remained |
| Concurrent trip generation | Failed in the first run. Fixed and retested in "Captain route generation concurrency" below |
| Transaction rollback | Passed. A user inserted inside a transaction that threw was absent afterward |
| Admin group assignment | Passed. `AdminGroupsController.assign` stored the captain and status `Assigned`. `publishGroup` was stubbed to re-read the row, so its side effects were not executed |
| Support message | Passed. The Arabic message was stored and the ticket owner received `SupportMessageCreated` on `/hubs/support-chat` |
| Nest boot and health | Passed, with the database identity check above |

### Defect found

`CaptainRoutesService.createTripsForDriver` used to read existing trips, skip times already present, and then insert. Two overlapping calls both observed an empty route and both inserted. The schema had no unique constraint on a generated departure. A second sequential call was safe. The production method was fixed in the following section.

### Ride categories

These rows are database-service results on the isolated database. No Rider or Captain mobile workflow was executed.

| Category | Executed | Not executed |
| --- | --- | --- |
| Individual ride | A `private_car` request was accepted and the assigned row was read back | Mobile request, tracking, and payment screens |
| Group car | A `group_car` request was offered to a nearby online car captain and accepted | Mobile group-car UI |
| Scooter | A car captain was rejected for `requestedVehicleKind = scooter`, and the row stayed `Requested` | Scooter captain acceptance and the scooter mobile flow |
| Shuttle | Two riders raced for the last seat. One booking and zero seats remained | Mobile shuttle search and ticket UI |
| Group trip | An authorized admin assignment wrote the captain and `Assigned` status | `publishGroup` side effects, and any captain self-accept path. Captains still have no self-accept service for `GroupRequest` |
| Captain routes | One occurrence generated one trip, and a repeated call generated none. Concurrent generation is covered by the next section | Mobile route management |

### Still not end to end

- No Rider or Captain device, emulator, or UI automation ran.
- Ride accept, booking, and group assignment were service calls with persisted assertions, not authenticated HTTP calls from the mobile clients.
- Facebook login and FCM delivery remain manual and unexecuted.
- A message sent while the support socket is disconnected is still not replayed on join. History remains a REST read.

## Captain route generation concurrency

### Root cause

`createTripsForDriver` decided which departures already existed, then inserted the rest outside any lock. The logical departure is the captain route plus the Africa/Cairo minute of `scheduledAt`. Seconds are not part of that identity. Cancelled and deleted trips do not occupy the minute, so the same departure can be generated again after cancellation. A route id and an exact timestamp are not the identity: two timestamps in the same Cairo minute are the same departure, and a different route at that minute is a different trip.

Platform and corridor scheduling can create several trips on one route at the same time. Those rows leave `DepartureSlot` null and are outside this constraint.

Before the index was created, `scripts/report-captain-trip-duplicates.mjs` reported `captainTrips: 0` and `duplicateGroups: 0` on `shuttlez_integration_test`. Nothing was deleted or merged.

### Implementation

Generation now runs in one transaction. It takes `pg_advisory_xact_lock(814201, hashtext(routeId))`, reads current trips again, and inserts only missing minutes. Each inserted captain trip stores `DepartureSlot` as `YYYY-MM-DD HH:mm` in Africa/Cairo.

PostgreSQL enforces the invariant with partial unique index `UX_TripsSet_Route_DepartureSlot` on `("RouteId", "DepartureSlot")` where the trip is not deleted, status is not cancelled (`5`), and the slot is not null. A second connection that inserts the same slot receives Prisma `P2002`. The service retries the locked insert once. If the slot is still taken, it returns the existing trip ids with `count: 0` instead of an HTTP 500.

`createTrips`, `adminCreate`, and `adminCreateTrips` all call `createTripsForDriver`, so they use the same path. Admin schedule and corridor demand do not.

### Schema deployment

The test database received `prisma/sql/20261027_captain_trip_departure_slot.sql` through `scripts/apply-captain-trip-slot.mjs`. That script checks the database name and port before applying. `scripts/start-integration-postgres.mjs` runs it after startup. No Prisma migration directory was created.

Production still needs that SQL file applied manually. Run `scripts/report-captain-trip-duplicates.mjs` against the target first. The SQL raises and stops when a captain route already has two active trips in the same Cairo minute. It does not delete or merge those rows. `prisma db push` does not create this partial index, and a later push can drop it because Prisma cannot represent the `WHERE` clause. Do not use `db push` as the production deployment step.

### Regression evidence

The isolated database test `keeps one trip when two generations run concurrently` now runs three overlapping `createTripsForDriver` calls. The persisted result is one trip. A retry and a call 30 seconds later in the same minute add nothing. The next calendar day creates a second trip. Another route at the original minute creates its own trip. A weekly Monday range from 2 November 2026 through 16 November 2026 keeps distinct slots, and the overlapping pair's created counts sum to the stored row count. Cancelling the first departure allows one replacement. A transaction that inserts a slot and then throws leaves that row absent. A second Prisma client inserting the same slot is rejected with `P2002`, so the constraint holds across database sessions.

Command:

```bash
npx jest src/modules/drivers/postgres-integration.spec.ts --runInBand --testTimeout 120000
```

Exit code 0. 14 passed, 14 total.

`npm test` excludes that file so the unit suite does not require the local database. `npm run test:integration` runs it.

### Other commands

| Command | Exit code | Result |
| --- | --- | --- |
| `npm test` | 0 | 25 suites, 191 tests passed |
| `npx tsc --noEmit` | 0 | No type errors |
| `flutter test test/captain_route_lifecycle_test.dart` in the Captain app | 0 | 7 passed |

### Remaining risks

- Admin schedule and corridor demand can still insert same-minute trips because they do not set `DepartureSlot`. Corridor demand does this on purpose for separate vehicles. An admin schedule on a captain route can still duplicate a generated departure.
- The advisory lock serializes one route. The unique index is what rejects a duplicate if another process skips the lock.
- This does not exercise the Rider or Captain mobile applications. Mobile-to-mobile ride workflows remain unexecuted.

## Admin schedule and other trip origins

### Paths that create a Trip

| Path | Logical departure | `DepartureSlot` |
| --- | --- | --- |
| `CaptainRoutesService.createTripsForDriver`, including captain `createTrips`, `adminCreate`, and `adminCreateTrips` | Captain route plus the Africa/Cairo minute | Set. Same lock and partial unique index |
| `AdminTripsController.generate` and `saveTrip` on a captain-owned route | Same captain-route departure | Set. Overlap with captain generation is skipped or returned as a duplicate error |
| `AdminTripsController.generate` and `saveTrip` on a platform route | Shuttle or platform schedule. Several trips may share a time | Null |
| `CorridorDemandService.apply` | One route, several vehicles at one time | Null on purpose |
| Route-demand launch on a captain-owned route | Same captain-route minute | Set, with the same lock |
| Route-demand launch on a platform route | Operational launch. Exact-time duplicate check remains | Null |
| Group assignment | Not a `Trip`. It updates `GroupRequest` | Not applicable |
| Scheduled jobs, retries, and seeders | None create trips | Not applicable |

There is no second uniqueness rule. The partial index applies only where `DepartureSlot` is present.

### Fix

Admin schedule previously inserted trips with no slot, so it could duplicate a captain departure even after the index existed. Captain-owned routes now use `departureSlotFor` and `pg_advisory_xact_lock(814201, hashtext(routeId))`. A unique-index conflict becomes `DUPLICATE_OPERATIONAL_TRIP` instead of an HTTP 500. Platform and corridor inserts keep the column null.

No new column or migration directory was added. `prisma/sql/20261027_captain_trip_departure_slot.sql` is unchanged in behavior. Its comment now names the admin and corridor cases. It still refuses to continue when a captain route already has two active trips in the same Cairo minute, and it does not delete or merge rows. `prisma db push` does not create this partial index.

Deploy the SQL before the API build that writes `DepartureSlot`. The column must exist first. Production was not contacted.

### Evidence

`does not let admin schedule duplicate a captain-route departure` ran on `shuttlez_integration_test`. Captain generation then admin schedule left one row. Admin schedule then captain generation left one row. Overlapping calls through both paths left one row, and a second database session received `P2002`. Cancelling the trip allowed one replacement. Another route and another day each created a distinct trip. Two platform schedules at the same minute both persisted with a null slot. `CorridorDemandService.apply` created two trips at the same timestamp with a null slot. Assigning a group created no `Trip`.

```bash
npx jest src/modules/drivers/postgres-integration.spec.ts --runInBand --testTimeout 120000
```

Exit code 0. 15 passed, 15 total.

| Command | Exit code | Result |
| --- | --- | --- |
| `npm test` | 0 | 25 suites, 191 tests |
| `npx tsc --noEmit` | 0 | No type errors |
| `flutter test test/captain_route_lifecycle_test.dart` | 0 | 7 passed |

### Remaining limitation

Corridor demand still leaves `DepartureSlot` null, including if it is ever pointed at a captain-owned route. That remains the intentional multi-vehicle exception. Rider and Captain mobile workflows were not executed.

## Mobile ride attempt

This section is not a mobile end-to-end result. The Rider and Captain apps were not launched, and no ride was created.

### Local targets

`flutter devices` in the Captain repo reported only Chrome and Edge. No phone was connected, and Windows desktop was not listed. `flutter emulators` listed four Android AVDs: `Flutter_Lite`, `Pixel_API_34`, `Pixel_Fast`, and `Pixel_Flutter`. None was started.

Both apps already have a web target. A debug Android build uses `http://10.0.2.2:3000`. A debug desktop or browser build uses `http://127.0.0.1:3000`. The production URL is `https://shuttlez-nodejs-api.vercel.app`, so a local run must pass `--dart-define=API_BASE_URL=http://10.0.2.2:3000` on an emulator, or `http://127.0.0.1:3000` on Chrome. The backend listens on `0.0.0.0` at port 3000.

The isolated PostgreSQL process was listening on port `54329`. A read-only count against `shuttlez_integration_test` returned:

- active admins: 0
- drivers: 0
- approved active drivers: 0
- passengers: 0

The API process was not started. Production was not contacted, and the database was not reset.

### Authentication that the apps already use

`POST /api/v1/auth/send-otp` returns `debugCode` from the existing OTP service. The Captain registration client sends that code to `POST /api/v1/auth/register` with `userType: driver`. The Rider client uses the same OTP endpoints. No token was minted outside those endpoints.

That registration is not enough for an offer. `AuthService.register` stores a driver with `verificationStatus` pending and `isActive` false. `DriversService.setAvailability` and ride acceptance call `requireDriver()`, which rejects an inactive captain with HTTP 403. Offer eligibility also requires `isOnline`, a location no older than 15 minutes, a pickup inside 5 km, and a car vehicle for an individual car request. Realtime paths are `/hubs/driver` for the captain and `/hubs/ride-tracking` for the ride.

Approving that captain is `PATCH /api/v1/admin/drivers/:id` with `verificationStatus: approved` and `isActive: true`. The admin OTP endpoints only accept an existing active user whose type is admin. This database has none, and no registration route creates the first admin.

### Lifecycle

| Step | Result |
| --- | --- |
| Captain online and availability persisted | NOT RUN |
| Rider creates an individual ride | NOT RUN |
| Backend persists the request and offers it | NOT RUN |
| Captain receives and accepts | NOT RUN |
| Exactly one assignment | NOT RUN |
| Rider sees acceptance without refresh | NOT RUN |
| Captain location reaches Rider | NOT RUN |
| Rider ETA or distance | NOT RUN |
| Arrival and start | NOT RUN |
| Both apps show the lifecycle state | NOT RUN |
| Completion | NOT RUN |
| Duplicate acceptance, reconnect, delayed events | NOT RUN |
| Disconnect recovery | NOT RUN |

No push notification was sent or observed.

### Next action

The first-admin gap below is now closed on the isolated database. The ride lifecycle is still not run. The next action is to register one Rider and one Captain through the apps, approve that captain with the real admin session, then launch `Pixel_Fast` and run one individual ride.

## Test admin bootstrap

No seed script, Prisma seed, or first-admin command existed. `package.json` has no seed script. An admin is not a separate table or role row. It is one `UsersSet` row:

- `UserType` `3` (`UserType.Admin`)
- `IsActive` true
- `IsDeleted` false
- `Phone` unique
- `RatingAverage` `0` and `RatingCount` `0`, the same defaults as `userDefaults`

`sendAdminOtp` looks up that phone, active flag, and user type, then stores a normal login OTP. `adminLogin` checks the same user type and active flag, verifies the OTP, and only then issues tokens. The access token role claim is `Admin` because `userTypeName(3)` returns that string. No wallet, driver, or refresh token is required before login.

`scripts/bootstrap-test-admin.mjs` is the test-only bootstrap. It reads the gitignored local URL, refuses any host other than `127.0.0.1`, any port other than `54329`, or any database other than `shuttlez_integration_test`, and checks `current_database()` and `inet_server_port()` again before writing. It inserts only the synthetic user `Integration Test Admin` at `+201000000099` when no active admin exists. A second run does not insert another row. It does not change authorization code.

Executed twice:

```bash
node scripts/bootstrap-test-admin.mjs
```

First result: `action=created`, `userType=3`, `isActive=true`, `activeAdmins=1`, database `shuttlez_integration_test`, port `54329`. Second result: `action=unchanged`, `activeAdmins=1`.

The API was then started with `PORT=3000`, `API_BASE_URL=http://127.0.0.1:3000`, `OTP_LOG_CODE_IN_DEVELOPMENT=false`, and `DATABASE_URL` taken from `.local/pg-test/database-url` before process start. Nest does not overwrite an existing `DATABASE_URL`. The server log recorded `PrismaService` connected. It did not print a connection string.

```bash
node scripts/verify-test-admin-login.mjs
```

Exit code 0. `GET /api/v1/health` returned HTTP 200, `status=healthy`, `service=Shuttlez.API`. The same script's read of the isolated database was `shuttlez_integration_test` on port `54329`. `POST /api/v1/admin/auth/send-otp` returned HTTP 201 and created an unused login OTP in that database. `POST /api/v1/admin/auth/login` returned HTTP 201 with `role=Admin`, marked the OTP used, and stored one active refresh token. The OTP value and tokens were not recorded. No Rider, Captain, or ride had been created at this point. Production was not contacted.

## Rider and Captain registration

Both Flutter clients read `API_BASE_URL` from `--dart-define`. The backend does not read it. An empty define uses the debug default: `http://127.0.0.1:3000` on web and desktop, and `http://10.0.2.2:3000` on Android. Release builds use `https://shuttlez-nodejs-api.vercel.app`. Production defaults were not changed.

Registration used the same endpoints as the apps, against the already running local API. Rows were not inserted directly. OTPs and tokens were not recorded.

```bash
node scripts/register-test-rider-captain.mjs
```

Exit code 0. Database `shuttlez_integration_test`, port `54329`.

| Account | Result |
| --- | --- |
| Rider `+201000000101` | Created. User `585f4279-1f51-4a72-93be-106d69469387`, `UserType` 1, active, not deleted |
| Captain `+201000000102` | Created through `POST /api/v1/auth/register` with `userType=driver`, `client=driver`, and `vehicleKind=car`. User `140197ff-89d3-4496-af6d-899f848dd794`, `UserType` 2. Driver `b2160b4b-e6a7-49ea-9f8e-6b3aae24d8d3` |

The admin session came from `POST /api/v1/admin/auth/send-otp` and `POST /api/v1/admin/auth/login`. `PATCH /api/v1/admin/drivers/b2160b4b-e6a7-49ea-9f8e-6b3aae24d8d3` sent only `isActive: true` and `verificationStatus: "approved"`. HTTP 200. The response said `Approved`, active, and `vehicleKind=car`. The isolated row then had `verificationStatus` 1, `isActive` true, `isOnline` false, and `vehicleKind` `car`.

## Captain app launch

`flutter emulators --launch Pixel_Fast` started `emulator-5554`, Android 14. `adb -s emulator-5554 emu geo fix 31.5860 30.1164` returned `OK`.

```bash
flutter run -d emulator-5554 --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

Exit code 1. `assembleDebug` failed in `android/app/build.gradle.kts` because the release signing block throws when `android/key.properties` is absent, and Gradle evaluates that block for a debug build. No keystore was created. The Captain app did not launch, so sign-in, location permission, online status, and offer eligibility were not executed. `isOnline` remains false. No ride was created.

### Next step

The debug signing blocker below is fixed and the Captain login screen was observed. Sign-in and the online toggle were later completed on this same session; the location result is in “Captain sign-in, location, and online”.

## Debug signing fix

`android/app/build.gradle.kts` created the release signing config during every Gradle configuration, so `assembleDebug` threw when `android/key.properties` was missing. The Rider app has the same unconditional throw. Only the Captain file was changed.

The release signing closure now returns immediately unless a requested Gradle task name contains `release`. Debug builds keep the automatic debug keystore. A release task still runs the existing Codemagic and `key.properties` checks and still refuses to fall back to the debug key. No keystore or secret was created. `.gitignore` already ignores `android/key.properties`.

```bash
flutter build apk --debug --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

Exit code 0. Output: `Built build\app\outputs\flutter-apk\app-debug.apk`. `flutter clean` and `flutter pub get` were not needed.

```bash
.\gradlew.bat :app:assembleRelease --quiet
```

Run from `android/`. Exit code 1. It still failed with `Missing release signing config` at `build.gradle.kts`.

```bash
flutter run -d emulator-5554 --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

The debug APK installed on `sdk gphone64 x86 64` (`emulator-5554`, Android 14). The app reached the Captain login screen: Shuttlez logo, phone field with `+20`, and the send-code button. A system “System UI isn’t responding” dialog and the notification permission prompt were dismissed. No phone number was entered, and no ride was created. `isOnline` was still false at that point.

## Captain sign-in, location, and online

The already-running Captain process on `emulator-5554` was used. It had been started with `--dart-define=API_BASE_URL=http://10.0.2.2:3000`. The local API was still the process bound to `127.0.0.1:3000` and `shuttlez_integration_test` on `127.0.0.1:54329`. No users were recreated and the database was not reset.

### Login — verified

The phone field already showed the `+20` prefix, so the digits `1000000102` were entered. The app’s send-code control called the normal OTP flow.

Observed app log, statuses only:

- `POST /api/v1/auth/send-otp` → 201
- `POST /api/v1/auth/verify-otp` → 201
- `POST /api/v1/notifications/devices` → 201
- `GET /api/v1/drivers/me` → 200
- `GET /api/v1/drivers/me/routes` → 200
- `GET /api/v1/drivers/me/trips` → 200

The home screen then showed “Integration Test Captain”. The OTP and tokens were not copied into this report. Authentication was not bypassed.

### Location — not verified

The in-app location sheet was accepted as precise, then the system dialog “While using the app” was accepted. `dumpsys package` afterwards showed `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` granted for `com.shuttlez.shuttlez_driver`. Location mode was already `3` (high accuracy).

The emulator command `adb -s emulator-5554 emu geo fix 31.5860 30.1164` returned `OK`. A later `geo nmea` sentence for the same point also returned `OK`. `dumpsys location` after both commands still showed:

- GPS, fused, and network `last location=null`
- GPS `mStarted=false`
- GNSS “Number of location reports: 0” for the whole emulator session

`DriversSet` has no latitude or longitude. The live point used by offer eligibility is the in-memory driver-gateway presence, written only by `JoinDriverRoom` or `UpdateDriverLocation` after Geolocator returns a position. The app connected to `/hubs/driver`, but no location-bearing HTTP call was made and no guest fix existed for Geolocator to submit. The 15-minute freshness check and the 5 km check therefore have no stored location to inspect. No location column was written.

### Online — persisted, eligibility not verified

The home-screen switch was turned on through the app. The app log showed `POST /api/v1/drivers/me/availability` → 201, then `[DriverSocket] Connected to driver gateway successfully`. The home screen changed to “متاح - متصل” and “في انتظار طلبات الركاب”.

A read-only Prisma query checked `current_database()` and `inet_server_port()` before reading driver `b2160b4b-e6a7-49ea-9f8e-6b3aae24d8d3`:

| Field | Value |
| --- | --- |
| Database | `shuttlez_integration_test` port `54329` |
| `isOnline` | true |
| `isActive` | true |
| `verificationStatus` | 1 (approved) |
| `vehicleKind` | `car` |
| `VehiclesSet` row | none |
| `updatedAt` | `2026-10-27T15:13:21.154Z` (the availability write) |
| Ride rows | 0 |

`vehicleKind` `car` is the value `captainVehicleKind` uses for a car offer. There is no separate vehicle-type row. Offer eligibility still requires a presence whose `updatedAt` is inside `LOCATION_FRESH_MS` (15 minutes) and a pickup within `OFFER_MAX_RADIUS_KM` (5 km). That presence was not observed, so this captain is not yet shown to be eligible for a car request.

### Next step

Get `emulator-5554` to deliver a real GNSS or fused fix to the Captain app. The console accepts `geo fix`, but this guest recorded zero location reports and never started the GPS provider while the app requests balanced accuracy. After a fix is visible to the app, confirm the driver gateway has a fresh presence for this captain at latitude `30.1164`, longitude `31.5860`. Only then launch the Rider app against `http://10.0.2.2:3000` and create one individual car ride whose pickup is within 5 km. Do not create that ride before the location is observed.

## Ride lifecycle audit — 2026-10-28

Protocol in all three repositories is Socket.IO. The only SignalR mention left in the Captain app is a comment in `chat_scaffold.dart`. Support chat uses `socket_io_client` on `/hubs/support-chat`. No protocol migration was made.

| Hub | Client | Transport |
| --- | --- | --- |
| `/hubs/driver` | Captain `DriverRealtimeClient` | Socket.IO. Chrome stays on long-polling because the websocket upgrade was closing the session |
| `/hubs/ride-tracking` | Rider `RideRealtimeClient`, Captain ride socket | Socket.IO |
| `/hubs/trip-tracking` | Shuttle tracking | Socket.IO |
| `/hubs/group` | Rider group hub | Socket.IO |
| `/hubs/rider` | Rider history | Socket.IO |
| `/hubs/support-chat` | Rider and Captain support | Socket.IO |

Auth is the JWT in `handshake.auth.token`. The server verifies it in `SocketIdentity` and rejects a claimed user id that does not match the token.

### Event contract

| Event | Producer | Transport | Target | Payload | Consumer | State change |
| --- | --- | --- | --- | --- | --- | --- |
| `NewRideRequest` | `DriverGateway.broadcastNewRide` | Socket.IO `/hubs/driver` | Captains inside the radius with a fresh presence | Ride offer, including `id` | Captain `DriverRealtimeClient` | Opens the incoming sheet |
| `RideRequestClaimed` | `DriverGateway.notifyClaimed` | Socket.IO `/hubs/driver` | Other online captains | `{ rideId }` | Captain home | Dismisses the offer |
| `RideRequestCancelled` | `DriverGateway.broadcastRideWithdrawn` | Socket.IO `/hubs/driver` | Captains who received that offer, plus the assigned captain | `{ rideId, status: 'Cancelled', cancelledBy: 'rider' }` | Captain home sheet | Removes the offer. Missing before this fix |
| `RideAccepted` | `RideTrackingGateway.publishRideAccepted` | Socket.IO `/hubs/ride-tracking` | `ride-{id}` and the rider user room | Mapped ride | Rider `RideRealtimeClient` | Rider leaves searching |
| `RideCancelled` | `RideTrackingGateway.publishRideCancelled` | Socket.IO `/hubs/ride-tracking` | `ride-{id}` only | `{ rideId, status, cancelledBy }` | Rider, and the Captain ride socket after accept | Does not reach a captain who only has the offer sheet |
| `RideStarted` | `RideTrackingGateway.publishRideStarted` | Socket.IO `/hubs/ride-tracking` | Ride room | `{ rideId, status, startedAt }` | Rider | In progress |
| `RideCompleted` | `RideTrackingGateway.publishRideCompleted` | Socket.IO `/hubs/ride-tracking` | Ride room | `{ rideId, status, completedAt, fareAmount }` | Rider | Completed |
| `RideStateSync` | Ride tracking gateway on join | Socket.IO `/hubs/ride-tracking` | Joining socket | Current ride row | Rider | Replaces local ride state |
| `CaptainLocationUpdated` | `RideTrackingGateway.broadcastLocation` | Socket.IO `/hubs/ride-tracking` | Ride room | `{ rideId, latitude, longitude }` | Rider | Map position |
| `UpdateDriverLocation` | Captain client | Socket.IO `/hubs/driver` | Server presence map | `{ latitude, longitude }` | `DriverGateway.rememberPresence` | Eligibility location. Not a ride event |

HTTP transitions stay authoritative: `POST /api/v1/rides`, `POST /api/v1/rides/:id/cancel`, `POST /api/v1/drivers/me/rides/:id/accept`, start and complete on the drivers controller. `GET /api/v1/drivers/me/pending-rides` returns only `Requested` rows.

### Root cause

`RidesService.cancel` wrote `Cancelled` and told the rider history hub. It did not tell `/hubs/driver`. `publishRideCancelled` emits `RideCancelled` only to `ride-{id}`. A captain looking at an offer has joined `driver-{userId}`, not the ride room, so the sheet stayed up. The API log for the earlier rides was `broadcastNewRide ... targeted 0 of 0 drivers` while Chrome was dropping the socket on websocket upgrade, so the offer arrived later from the 15-second pending-rides poll. That poll does not remove an offer that is already on screen, and it is skipped while the socket reports connected.

### Fix

- Cancel uses `updateMany` on the status it just read (`Requested` or `Assigned`). A concurrent accept changes that status, so only one transition commits. A second cancel returns the cancelled row.
- The gateway remembers who received `NewRideRequest`, and also remembers a captain who loaded the ride from `pending-rides`.
- Cancel emits `RideRequestCancelled` to those captains. The Captain cubit drops the id, and the home sheet closes.
- Accept of a cancelled row was already rejected by `decideRideAccept` and the conditional claim update. Pending rides still exclude cancelled rows, so a later poll cannot put the offer back.

### Tests

| Suite | Result |
| --- | --- |
| `ride-offer-policy.spec.ts` and `driver-gateway.spec.ts` | 24 passed |
| PostgreSQL integration, cancel-then-accept and accept/cancel race, database `shuttlez_integration_test` on `127.0.0.1:54329` | 2 passed, 14 skipped by name filter |
| `tsc --noEmit` | exit 0 |
| Captain `flutter analyze` on the three edited files | no issues |
| Captain `flutter test test/api_dedup_and_realtime_test.dart` | 5 passed |
| Rider `ride_phase6n_booking_hub_test`, `private_product_error_mapper_test`, `api_inflight_dedup_test` | 17 passed |

Live process on port 3000, same isolated database: captain socket received `NewRideRequest` for the created ride, then `RideRequestCancelled` after `POST /api/v1/rides/:id/cancel` returned 201. Accept returned 400. Pending rides no longer contained that id. Server log: `targeted 1 of 1 drivers`, then `RideRequestCancelled ... notified 1`.

The Flutter sheet itself was not seen. The automation browser loaded `http://127.0.0.1:8081/` as a black Flutter canvas with no accessibility tree, and the Chrome window started by `flutter run` was not on the primary monitor. This is not a mobile E2E pass.

### Performance

Health on the local API, 20 samples: p50 25 ms, p95 33 ms, max 86 ms. That endpoint does not touch ride queries.

`pendingNearbyRides` is one `findMany` (`status = Requested`, `createdAt` within 15 minutes, `take: 20`) plus in-memory eligibility. Cancel is one conditional update and one reload, then an in-memory recipient list. No per-captain query was added.

The Captain poll stays at 15 seconds and still runs the pending fetch only while the driver socket is disconnected. The earlier multi-second delay was the missing cancel event and the websocket upgrade disconnect, not a slow SQL statement. The driving-distance quote still calls an external router. That latency was not measured again in this pass.

### Priority

| Level | Item |
| --- | --- |
| P0 | Fixed: a cancelled request could stay on the captain sheet, and a racing accept could be overwritten by an unconditional cancel update |
| P1 | Fixed on the server and the Captain client: `RideRequestCancelled` to the captains who actually received the offer. The on-screen sheet was not visually confirmed |
| P1 | Chrome websocket upgrade still must stay disabled; long-polling is the stable Captain transport there |
| P2 | Health is fast. The external driving-route call on quote/create is the unmeasured slow path |
| P3 | Stale SignalR comments. No SignalR client remains on the ride path |

## UI verification attempt — 2026-10-28, stopped at the database gate

The Captain offer sheet was not opened and was not observed. No Rider or Captain browser session was started for this attempt.

The API process on port 3000 was started with `DATABASE_URL` cleared, so Nest loaded `.env` and kept that value over `.env.local` (that file does not define `DATABASE_URL`). The live connection is remote Neon, port 5432, database `shuttlez_integration_test`. It is not the production database name `neondb`, and it is not the isolated local database.

| Check | Result |
| --- | --- |
| Running API database | Remote Neon, database `shuttlez_integration_test`, port 5432 |
| Isolated test database | `127.0.0.1:54329`, database `shuttlez_integration_test`, starter still running |
| Same database | No |
| Apps opened | No |
| `NewRideRequest` observed in the Captain UI | Not run |
| `RideRequestCancelled` observed in the Captain UI | Not run |
| Offer sheet shown | Not observed |
| Offer sheet dismissed | Not observed |
| Cancellation-to-dismissal latency | Not measured |
| Stale response or reconnect restored the offer | Not run |
| Test users | Not used |

Blocker: the safety gate requires the API to be on the isolated local database before any UI interaction. The current API is on the remote Neon database of the same name.

Next action: restart the API with the isolated URL from `.local/pg-test/database-url`, confirm host `127.0.0.1`, port `54329`, and database `shuttlez_integration_test`, then repeat this UI scenario. Do not point that restart at Neon or at `neondb`.
