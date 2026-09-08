# API Inventory

Source: every controller under `E:\aa_MOC\Flutter_Projects\shuttlez-cursor-api\src\Shuttlez.API\Controllers` (31 controller classes) plus SignalR hubs in `Program.cs`.

Prefix: `/api/v1` unless noted. Envelope: `{ success, data, message, code, errors }` camelCase.

Auth model in .NET: most public controllers are `[AllowAnonymous]` and the handler uses `ICurrentUserService` (JWT if present). Exceptions: `[Authorize]` on Groups, Rides, `POST /bookings`, `POST /route-requests`; `[AdminOnly]` on all Admin controllers except `POST /admin/auth/send-otp` and `POST /admin/auth/login`.

| Totals | Count |
|---|---|
| HTTP endpoints | **172** |
| Public / customer / captain | **76** |
| Admin | **96** |
| SignalR hubs | **3** |

Node Status values: **Implemented** · **Partial** · **Stub** (410/501/error) · **Not Started**

---

## 1. Health

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/health` | HealthController | Public | Implemented |

---

## 2. Auth (customer)

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| POST | `/api/v1/auth/send-otp` | AuthController.SendOtp | Public | Implemented |
| POST | `/api/v1/auth/verify-otp` | AuthController.VerifyOtp | Public | Implemented |
| POST | `/api/v1/auth/register` | AuthController.Register | Public | Implemented |
| POST | `/api/v1/auth/social-login` | AuthController.SocialLogin | Public | Implemented |
| POST | `/api/v1/auth/social-send-otp` | AuthController.SocialSendOtp | Public | Implemented |
| POST | `/api/v1/auth/social-complete` | AuthController.SocialComplete | Public | Implemented |
| POST | `/api/v1/auth/refresh-token` | AuthController.RefreshToken | Public | Implemented |
| POST | `/api/v1/auth/logout` | AuthController.Logout | Public | Implemented |

---

## 3. Users

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/users/me` | UsersController.GetMe | JWT in handler | Implemented |
| PATCH | `/api/v1/users/me` | UsersController.UpdateMe | JWT in handler | Implemented |

Body PATCH: `{ fullName, email, gender, avatarUrl }`

---

## 4. Content

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/content/faq` | ContentController.GetFaq | Public | Implemented |
| GET | `/api/v1/content/legal/{slug}` | ContentController.GetLegal | Public | Implemented |

Legal query/header: `lang` or `language` or `Accept-Language`

---

## 5. Landing

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/landing/route-request-options` | LandingController.GetRouteOptions | Public | Implemented |
| GET | `/api/v1/landing/popular-routes` | LandingController.GetPopularRoutes | Public | Implemented (simplified) |
| GET | `/api/v1/landing/routes` | LandingController.GetRoutes | Public | Implemented |
| GET | `/api/v1/landing/routes/{id}/map` | LandingController.GetRouteMap | Public | Implemented (simplified) |
| GET | `/api/v1/landing/config` | LandingController.GetConfig | Public | Implemented |
| POST | `/api/v1/landing/route-requests` | LandingController.SubmitRouteRequest | Public | Implemented |
| POST | `/api/v1/landing/waitlist` | LandingController.SubmitWaitlist | Public | Implemented |
| POST | `/api/v1/landing/captains` | LandingController.SubmitCaptain | Public | Implemented |

Language from `Accept-Language` on GET routes.

---

## 6. Saved locations

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/users/me/saved-locations` | SavedLocationsController.GetAll | JWT in handler | Implemented |
| POST | `/api/v1/users/me/saved-locations` | SavedLocationsController.Create | JWT in handler | Implemented |
| PATCH | `/api/v1/users/me/saved-locations/{id}` | SavedLocationsController.Update | JWT in handler | Implemented |
| DELETE | `/api/v1/users/me/saved-locations/{id}` | SavedLocationsController.Delete | JWT in handler | Implemented |
| PATCH | `/api/v1/users/me/saved-locations/{id}/favorite` | SavedLocationsController.ToggleFavorite | JWT in handler | Implemented |

---

## 7. Notifications (customer)

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/notifications/me` | NotificationsController.GetMine | JWT in handler | Implemented |
| PATCH | `/api/v1/notifications/{id}/read` | NotificationsController.MarkRead | JWT in handler | Implemented |
| POST | `/api/v1/notifications/devices` | NotificationsController.RegisterDevice | JWT in handler | Implemented |
| DELETE | `/api/v1/notifications/devices/{token}` | NotificationsController.UnregisterDevice | JWT in handler | Implemented |

---

## 8. Routes (public catalog)

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/routes` | RoutesController.GetRoutes | Public | Implemented |
| GET | `/api/v1/routes/{id}/timeline` | RoutesController.GetTimeline | Public | Partial (stop list subset) |

---

## 9. Route requests (app)

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/route-requests/options` | RouteRequestsController.GetOptions | Public | Not Started |
| POST | `/api/v1/route-requests` | RouteRequestsController.Create | JWT `[Authorize]` | Not Started |

---

## 10. Customer trips (deprecated)

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| POST | `/api/v1/customer-trips` | CustomerTripsController.Create | Public | Implemented (410 deprecated) |

---

## 11. Subscription packages

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/subscription-packages` | SubscriptionPackagesController.GetPackages | Public | Implemented |
| GET | `/api/v1/subscription-packages/me` | SubscriptionPackagesController.GetMine | JWT in handler | Implemented |
| POST | `/api/v1/subscription-packages/{id}/subscribe` | SubscriptionPackagesController.Subscribe | JWT in handler | Partial |

---

## 12. Trips (customer bookings on shuttle trips)

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/trips/me` | TripsController.GetMyTrips | JWT in handler | Partial (shape may differ) |
| GET | `/api/v1/trips/{id}` | TripsController.GetDetails | JWT in handler | Partial |
| GET | `/api/v1/trips/{id}/invoice` | TripsController.GetInvoice | JWT in handler | Partial |
| POST | `/api/v1/trips/{id}/cancel` | TripsController.Cancel | JWT in handler | Partial (seat restore SQL) |

---

## 13. Bookings

| Method | Route | .NET | Auth | Query / notes | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/bookings/preview` | BookingsController.GetPreview | Public | `sourceLatitude`, `sourceLongitude`, `destinationLatitude`, `destinationLongitude`, `sourceAddress`, `destinationAddress`, `sourceTime`, `destinationTime`, `vehicleTypeIndex` (default 1) | Stub (pricing) |
| POST | `/api/v1/bookings` | BookingsController.Create | JWT `[Authorize]` | Body `CreateBookingRequest`; paymentMethod must be CASH | Stub (501) |

---

## 14. Rides (private ride product)

Controller: `[Authorize]`. Quote query: `fromZoneKey`, `toZoneKey`, `pickupLatitude`, `pickupLongitude`, `destinationLatitude`, `destinationLongitude`.

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/rides/quote` | RidesController.Quote | JWT | Stub |
| GET | `/api/v1/rides/fare-options` | RidesController.FareOptions | JWT | Partial |
| POST | `/api/v1/rides` | RidesController.Create | JWT | Stub (501) |
| GET | `/api/v1/rides/me` | RidesController.GetMe | JWT | Partial |
| GET | `/api/v1/rides/{rideId}` | RidesController.GetById | JWT | Not Started |
| POST | `/api/v1/rides/{rideId}/cancel` | RidesController.Cancel | JWT | Not Started |

---

## 15. Groups (shared ride product)

Controller: `[Authorize]`. Quote query same as rides.

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/groups/quote` | GroupsController.Quote | JWT | Not Started |
| GET | `/api/v1/groups/fare-options` | GroupsController.FareOptions | JWT | Not Started |
| POST | `/api/v1/groups` | GroupsController.Create | JWT | Not Started |
| POST | `/api/v1/groups/{groupId}/join` | GroupsController.Join | JWT | Not Started |
| POST | `/api/v1/groups/{groupId}/leave` | GroupsController.Leave | JWT | Not Started |
| POST | `/api/v1/groups/{groupId}/confirm` | GroupsController.ConfirmCash | JWT | Not Started |
| GET | `/api/v1/groups/me` | GroupsController.GetMe | JWT | Not Started |
| GET | `/api/v1/groups/{groupId}` | GroupsController.GetById | JWT | Not Started |
| POST | `/api/v1/groups/{groupId}/cancel` | GroupsController.Cancel | JWT | Not Started |

---

## 16. Drivers (captain app)

Auth: JWT in handler. `GET /drivers/me/trips` is rate-limited **12 req/min** per user or IP (`DriverTripsRateLimitMiddleware`). Document upload max 16 MB.

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/drivers/me` | DriversController.GetMe | JWT in handler | Not Started |
| POST | `/api/v1/drivers/me/documents` | DriversController.UploadMyDocument | JWT in handler | Not Started |
| GET | `/api/v1/drivers/me/trips` | DriversController.GetMyTrips | JWT in handler + 12/min | Not Started |
| POST | `/api/v1/drivers/me/trips/{tripId}/start` | DriversController.StartMyTrip | JWT in handler | Not Started |
| POST | `/api/v1/drivers/me/trips/{tripId}/complete` | DriversController.CompleteMyTrip | JWT in handler | Not Started |
| GET | `/api/v1/drivers/me/ratings` | DriversController.GetMyRatings | JWT in handler | Not Started |
| GET | `/api/v1/drivers/me/rides` | DriversController.GetMyRides | JWT in handler | Not Started |
| POST | `/api/v1/drivers/me/rides/{rideId}/start` | DriversController.StartMyRide | JWT in handler | Not Started |
| POST | `/api/v1/drivers/me/rides/{rideId}/complete` | DriversController.CompleteMyRide | JWT in handler | Not Started |
| POST | `/api/v1/drivers/me/rides/{rideId}/location` | DriversController.UpdateMyRideLocation | JWT in handler | Not Started |
| GET | `/api/v1/drivers/me/groups` | DriversController.GetMyGroups | JWT in handler | Not Started |
| POST | `/api/v1/drivers/me/groups/{groupId}/start` | DriversController.StartMyGroup | JWT in handler | Not Started |
| POST | `/api/v1/drivers/me/groups/{groupId}/complete` | DriversController.CompleteMyGroup | JWT in handler | Not Started |

---

## 17. Support (customer)

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/support/tickets` | SupportController.GetTickets | JWT in handler | Partial (`tab=current\|closed`) |
| POST | `/api/v1/support/tickets` | SupportController.CreateTicket | JWT in handler | Partial |
| GET | `/api/v1/support/tickets/{id}/messages` | SupportController.GetMessages | JWT in handler | Not Started |
| POST | `/api/v1/support/tickets/{id}/messages` | SupportController.SendMessage | JWT in handler | Not Started |

---

## 18. Admin auth

`send-otp` / `login` are public. `me` is `[AdminOnly]`.

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| POST | `/api/v1/admin/auth/send-otp` | AdminAuthController.SendOtp | Public (admin phone only) | Implemented |
| POST | `/api/v1/admin/auth/login` | AdminAuthController.Login | Public | Implemented |
| GET | `/api/v1/admin/auth/me` | AdminAuthController.Me | AdminOnly | Implemented |

---

## 19. Admin dashboard

| Method | Route | .NET | Auth | Query | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/dashboard` | AdminDashboardController.Get | AdminOnly | `days` (default 30) | Partial |

---

## 20. Admin users

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/users` | AdminUsersController.List | AdminOnly | `search`, `userType`, `isActive`, `page`, `pageSize` | Partial (list only) |
| GET | `/api/v1/admin/users/{id}` | AdminUsersController.Get | AdminOnly | | Not Started |
| POST | `/api/v1/admin/users` | AdminUsersController.Create | AdminOnly | `CreateAdminUserRequest` | Not Started |
| PATCH | `/api/v1/admin/users/{id}` | AdminUsersController.Update | AdminOnly | `UpdateAdminUserRequest` | Not Started |
| DELETE | `/api/v1/admin/users/{id}` | AdminUsersController.Delete | AdminOnly | | Not Started |
| POST | `/api/v1/admin/users/{id}/wallet` | AdminUsersController.AdjustWallet | AdminOnly | `AdjustWalletRequest` | Not Started |

---

## 21. Admin vehicles

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/vehicles` | AdminVehiclesController.List | AdminOnly | `search`, `type`, `isActive`, `page`, `pageSize` | Not Started |
| POST | `/api/v1/admin/vehicles` | AdminVehiclesController.Create | AdminOnly | `SaveVehicleRequest` | Not Started |
| PUT | `/api/v1/admin/vehicles/{id}` | AdminVehiclesController.Update | AdminOnly | `SaveVehicleRequest` | Not Started |
| DELETE | `/api/v1/admin/vehicles/{id}` | AdminVehiclesController.Delete | AdminOnly | | Not Started |

---

## 22. Admin drivers (fleet captains)

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/drivers` | AdminDriversController.List | AdminOnly | `search`, `isOnline`, `isActive`, `page`, `pageSize` | Not Started |
| GET | `/api/v1/admin/drivers/{id}` | AdminDriversController.Get | AdminOnly | | Not Started |
| POST | `/api/v1/admin/drivers` | AdminDriversController.Create | AdminOnly | `CreateDriverRequest` | Not Started |
| PATCH | `/api/v1/admin/drivers/{id}` | AdminDriversController.Update | AdminOnly | `UpdateDriverRequest` | Not Started |
| POST | `/api/v1/admin/drivers/{id}/documents` | AdminDriversController.UploadDocument | AdminOnly | multipart `file` + `documentType` + `notes` (16 MB) | Not Started |
| DELETE | `/api/v1/admin/drivers/{id}/documents/{documentId}` | AdminDriversController.DeleteDocument | AdminOnly | | Not Started |
| DELETE | `/api/v1/admin/drivers/{id}` | AdminDriversController.Delete | AdminOnly | | Not Started |

---

## 23. Admin routes

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/routes` | AdminRoutesController.List | AdminOnly | `search`, `isActive`, `page`, `pageSize` | Not Started |
| GET | `/api/v1/admin/routes/{id}` | AdminRoutesController.Get | AdminOnly | | Not Started |
| POST | `/api/v1/admin/routes` | AdminRoutesController.Create | AdminOnly | `SaveRouteRequest` | Not Started |
| PUT | `/api/v1/admin/routes/{id}` | AdminRoutesController.Update | AdminOnly | `SaveRouteRequest` | Not Started |
| DELETE | `/api/v1/admin/routes/{id}` | AdminRoutesController.Delete | AdminOnly | | Not Started |
| PUT | `/api/v1/admin/routes/{id}/stops` | AdminRoutesController.ReplaceStops | AdminOnly | `List<SaveStopRequest>` | Not Started |
| GET | `/api/v1/admin/routes/{id}/demand` | AdminRoutesController.Demand | AdminOnly | corridor demand report | Not Started |
| POST | `/api/v1/admin/routes/{id}/demand/apply` | AdminRoutesController.ApplyDemand | AdminOnly | `ApplyCorridorDemandRequest` | Not Started |

---

## 24. Admin trips

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/trips` | AdminTripsController.List | AdminOnly | `routeId`, `driverId`, `status`, `from`, `to`, `page`, `pageSize` | Not Started |
| POST | `/api/v1/admin/trips` | AdminTripsController.Create | AdminOnly | `SaveTripRequest` | Not Started |
| PUT | `/api/v1/admin/trips/{id}` | AdminTripsController.Update | AdminOnly | `SaveTripRequest` | Not Started |
| PUT | `/api/v1/admin/trips/{tripId}/driver` | AdminTripsController.AssignDriver | AdminOnly | `{ driverId }` | Not Started |
| DELETE | `/api/v1/admin/trips/{tripId}/driver` | AdminTripsController.UnassignDriver | AdminOnly | | Not Started |
| DELETE | `/api/v1/admin/trips/{id}` | AdminTripsController.Delete | AdminOnly | | Not Started |
| POST | `/api/v1/admin/trips/generate` | AdminTripsController.Generate | AdminOnly | `GenerateTripsRequest` | Not Started |

---

## 25. Admin bookings

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/bookings` | AdminBookingsController.List | AdminOnly | `search`, `tripId`, `userId`, `status`, `page`, `pageSize` | Not Started |
| PATCH | `/api/v1/admin/bookings/{id}/status` | AdminBookingsController.UpdateStatus | AdminOnly | `UpdateBookingStatusRequest` | Not Started |

---

## 26. Admin reviews

| Method | Route | .NET | Auth | Query | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/reviews` | AdminReviewsController.List | AdminOnly | `driverId`, `minStars`, `page`, `pageSize` | Not Started |
| DELETE | `/api/v1/admin/reviews/{id}` | AdminReviewsController.Delete | AdminOnly | | Not Started |

---

## 27. Admin route-requests (inbox)

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/route-requests` | AdminRouteRequestsController.List | AdminOnly | `search`, `status`, `page`, `pageSize` | Not Started |
| PATCH | `/api/v1/admin/route-requests/{id}/status` | AdminRouteRequestsController.UpdateStatus | AdminOnly | `UpdateRouteRequestStatusRequest` | Not Started |
| DELETE | `/api/v1/admin/route-requests/{id}` | AdminRouteRequestsController.Delete | AdminOnly | | Not Started |

---

## 28. Admin landing leads

| Method | Route | .NET | Auth | Query | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/leads` | AdminLeadsController.List | AdminOnly | `kind`, `search`, `page`, `pageSize` | Not Started |

---

## 29. Admin FAQ

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/admin/faq` | AdminFaqController.List | AdminOnly | Not Started |
| POST | `/api/v1/admin/faq` | AdminFaqController.Create | AdminOnly | Not Started |
| PUT | `/api/v1/admin/faq/{id}` | AdminFaqController.Update | AdminOnly | Not Started |
| DELETE | `/api/v1/admin/faq/{id}` | AdminFaqController.Delete | AdminOnly | Not Started |

---

## 30. Admin legal

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/admin/legal` | AdminLegalController.List | AdminOnly | Not Started |
| POST | `/api/v1/admin/legal` | AdminLegalController.Create | AdminOnly | Not Started |
| PUT | `/api/v1/admin/legal/{id}` | AdminLegalController.Update | AdminOnly | Not Started |
| DELETE | `/api/v1/admin/legal/{id}` | AdminLegalController.Delete | AdminOnly | Not Started |

---

## 31. Admin packages

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/admin/packages` | AdminPackagesController.List | AdminOnly | Not Started |
| POST | `/api/v1/admin/packages` | AdminPackagesController.Create | AdminOnly | Not Started |
| PUT | `/api/v1/admin/packages/{id}` | AdminPackagesController.Update | AdminOnly | Not Started |
| DELETE | `/api/v1/admin/packages/{id}` | AdminPackagesController.Delete | AdminOnly | Not Started |

---

## 32. Admin commission rules

| Method | Route | .NET | Auth | Node |
|---|---|---|---|---|
| GET | `/api/v1/admin/commission-rules` | AdminCommissionController.List | AdminOnly | Not Started |
| POST | `/api/v1/admin/commission-rules` | AdminCommissionController.Create | AdminOnly | Not Started |
| PUT | `/api/v1/admin/commission-rules/{id}` | AdminCommissionController.Update | AdminOnly | Not Started |

No DELETE on commission rules.

---

## 33. Admin pricing rules

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/pricing-rules` | AdminPricingController.List | AdminOnly | `routeId`, `vehicleType`, `activeOnly` | Not Started |
| POST | `/api/v1/admin/pricing-rules` | AdminPricingController.Create | AdminOnly | `SavePricingRuleRequest` | Not Started |
| PUT | `/api/v1/admin/pricing-rules/{id}` | AdminPricingController.Update | AdminOnly | `SavePricingRuleRequest` | Not Started |
| DELETE | `/api/v1/admin/pricing-rules/{id}` | AdminPricingController.Delete | AdminOnly | | Not Started |
| POST | `/api/v1/admin/pricing-rules/preview` | AdminPricingController.Preview | AdminOnly | `PricingPreviewRequest` | Not Started |

---

## 34. Admin earnings

| Method | Route | .NET | Auth | Query | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/earnings/trips` | AdminEarningsController.TripEarnings | AdminOnly | `from`, `to`, `driverId`, `routeId` | Not Started |

---

## 35. Admin groups

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/groups` | AdminGroupsController.List | AdminOnly | `status`, `driverId`, `organizerUserId`, `page`, `pageSize` | Not Started |
| PUT | `/api/v1/admin/groups/{groupId}/driver` | AdminGroupsController.AssignDriver | AdminOnly | `{ driverId }` | Not Started |
| DELETE | `/api/v1/admin/groups/{groupId}/driver` | AdminGroupsController.UnassignDriver | AdminOnly | | Not Started |

---

## 36. Admin rides

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/rides` | AdminRidesController.List | AdminOnly | `status`, `driverId`, `riderUserId`, `page`, `pageSize` | Not Started |
| PUT | `/api/v1/admin/rides/{rideId}/driver` | AdminRidesController.AssignDriver | AdminOnly | `{ driverId }` | Not Started |
| DELETE | `/api/v1/admin/rides/{rideId}/driver` | AdminRidesController.UnassignDriver | AdminOnly | | Not Started |

---

## 37. Admin group fare rules

| Method | Route | .NET | Auth | Query | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/group-fare-rules` | AdminGroupFareController.List | AdminOnly | `activeOnly` | Not Started |
| POST | `/api/v1/admin/group-fare-rules` | AdminGroupFareController.Create | AdminOnly | | Not Started |
| PUT | `/api/v1/admin/group-fare-rules/{id}` | AdminGroupFareController.Update | AdminOnly | | Not Started |
| DELETE | `/api/v1/admin/group-fare-rules/{id}` | AdminGroupFareController.Delete | AdminOnly | | Not Started |

---

## 38. Admin ride fare rules

| Method | Route | .NET | Auth | Query | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/ride-fare-rules` | AdminRideFareController.List | AdminOnly | `activeOnly` | Not Started |
| POST | `/api/v1/admin/ride-fare-rules` | AdminRideFareController.Create | AdminOnly | | Not Started |
| PUT | `/api/v1/admin/ride-fare-rules/{id}` | AdminRideFareController.Update | AdminOnly | | Not Started |
| DELETE | `/api/v1/admin/ride-fare-rules/{id}` | AdminRideFareController.Delete | AdminOnly | | Not Started |

---

## 39. Admin support

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/support/tickets` | AdminSupportController.Tickets | AdminOnly | `search`, `status`, `page`, `pageSize` | Not Started |
| GET | `/api/v1/admin/support/tickets/{id}/messages` | AdminSupportController.Messages | AdminOnly | | Not Started |
| POST | `/api/v1/admin/support/tickets/{id}/messages` | AdminSupportController.Reply | AdminOnly | `ReplyTicketRequest` | Not Started |
| PATCH | `/api/v1/admin/support/tickets/{id}/status` | AdminSupportController.UpdateStatus | AdminOnly | `UpdateTicketStatusRequest` | Not Started |

---

## 40. Admin notifications

| Method | Route | .NET | Auth | Query / body | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/notifications` | AdminNotificationsController.List | AdminOnly | `userId`, `page`, `pageSize` | Not Started |
| POST | `/api/v1/admin/notifications/broadcast` | AdminNotificationsController.Broadcast | AdminOnly | `BroadcastNotificationRequest` | Not Started |

---

## 41. Admin route-demand

Base: `/api/v1/admin/route-demand`. List/export filters: `search`, `from`, `to`, `vehicleType`, `priority`, `status`, `routeType`, `routeCategory`, `createdFrom`, `createdTo`, `launchStatus`, `pricingAvailable`, `readyToLaunch` (+ `page`/`pageSize` on list).

| Method | Route | .NET | Auth | Notes | Node |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/route-demand/summary` | AdminRouteDemandController.Summary | AdminOnly | | Not Started |
| GET | `/api/v1/admin/route-demand` | AdminRouteDemandController.List | AdminOnly | paged analysis | Not Started |
| GET | `/api/v1/admin/route-demand/export` | AdminRouteDemandController.Export | AdminOnly | same filters, no paging | Not Started |
| GET | `/api/v1/admin/route-demand/launch-plan` | AdminRouteDemandController.LaunchPlan | AdminOnly | `routeKey`, `vehicleType`, `launchStatus`, `readyToLaunch`, `pricingAvailable`, `search` | Not Started |
| GET | `/api/v1/admin/route-demand/vehicle-capacities` | AdminRouteDemandController.VehicleCapacities | AdminOnly | | Not Started |
| GET | `/api/v1/admin/route-demand/details` | AdminRouteDemandController.Details | AdminOnly | query `routeKey` | Not Started |
| GET | `/api/v1/admin/route-demand/passengers` | AdminRouteDemandController.Passengers | AdminOnly | query `routeKey` | Not Started |
| PATCH | `/api/v1/admin/route-demand/status` | AdminRouteDemandController.UpdateStatus | AdminOnly | query `routeKey` + body | Not Started |
| PUT | `/api/v1/admin/route-demand/map-route` | AdminRouteDemandController.MapRoute | AdminOnly | query `routeKey` + `{ routeId }` | Not Started |
| DELETE | `/api/v1/admin/route-demand/map-route` | AdminRouteDemandController.UnmapRoute | AdminOnly | query `routeKey` | Not Started |
| POST | `/api/v1/admin/route-demand/launch` | AdminRouteDemandController.Launch | AdminOnly | query `routeKey` + `LaunchRouteDemandRequest`; creates one Trip when READY | Not Started |

---

## 42. SignalR hubs

Mapped in `Program.cs`. Nest gateways are not started.

| Hub | Path | Auth | Client methods |
|---|---|---|---|
| TripTrackingHub | `/hubs/trip-tracking` | Anonymous | `JoinTrip`, `LeaveTrip`, `BroadcastDriverLocation` |
| SupportChatHub | `/hubs/support-chat` | JWT | `JoinTicket`, `LeaveTicket` |
| DriverHub | `/hubs/driver` | JWT | auto-join `driver-{userId}` on connect; `JoinDriverRoom` |

---

## Node coverage vs .NET

| Area | .NET count | Node |
|---|---|---|
| Health, auth, users, content, landing, saved locations, notifications, admin auth | 33 | Implemented |
| Routes catalog, customer-trips 410, packages, trips, support list/create, admin dashboard + users list | 16 | Partial / stub mixed |
| Bookings, remaining rides | 6 | Stub or missing GET/cancel |
| Route-requests, groups, drivers | 24 | Not Started |
| Admin (except auth + dashboard + users list) | 91 | Not Started |
| SignalR | 3 hubs | Not Started |

Implemented here means the Nest route exists and talks to Prisma or returns the documented 410; it does not mean contract-tested against live .NET.
