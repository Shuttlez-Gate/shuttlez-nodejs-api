# API Inventory

All routes use prefix `/api/v1` unless noted. Envelope: `{ success, data, message, code, errors }` camelCase.

Auth model: global anonymous + handler `ICurrentUserService` checks, except `[AdminOnly]`.

| Method | Route | .NET | Node | Auth | Status |
|---|---|---|---|---|---|
| GET | /api/v1/health | HealthController | HealthController | Public | Implemented |
| POST | /api/v1/auth/send-otp | AuthController → SendOtpCommand | AuthService.sendOtp | Public | Implemented |
| POST | /api/v1/auth/verify-otp | VerifyOtpCommand | AuthService.verifyOtp | Public | Implemented |
| POST | /api/v1/auth/register | RegisterCommand | AuthService.register | Public | Implemented |
| POST | /api/v1/auth/social-login | SocialLoginCommand | AuthService.socialLogin | Public | Implemented |
| POST | /api/v1/auth/social-send-otp | SocialSendOtpCommand | AuthService.socialSendOtp | Public | Implemented |
| POST | /api/v1/auth/social-complete | SocialCompleteCommand | AuthService.socialComplete | Public | Implemented |
| POST | /api/v1/auth/refresh-token | RefreshTokenCommand | AuthService.refreshToken | Public | Implemented |
| POST | /api/v1/auth/logout | LogoutCommand | AuthService.logout | Public | Implemented |
| GET | /api/v1/users/me | GetCurrentUserQuery | AuthService.getMe | JWT in handler | Implemented |
| PATCH | /api/v1/users/me | UpdateProfileCommand | AuthService.updateMe | JWT | Implemented |
| POST | /api/v1/admin/auth/send-otp | SendAdminOtpCommand | AuthService.sendAdminOtp | Public | Implemented |
| POST | /api/v1/admin/auth/login | AdminLoginCommand | AuthService.adminLogin | Public | Implemented |
| GET | /api/v1/admin/auth/me | AdminMeQuery | AuthService.adminMe | AdminOnly | Implemented |
| GET | /api/v1/content/faq | GetFaqQuery | ContentService | Public | Implemented |
| GET | /api/v1/content/legal/{slug} | GetLegalDocumentQuery | ContentService | Public | Implemented |
| GET/POST | /api/v1/landing/* | Landing* | LandingService | Public | Implemented (map/popular simplified) |
| CRUD | /api/v1/users/me/saved-locations | LocationHandlers | SavedLocationsController | JWT | Implemented |
| GET/PATCH/POST/DELETE | /api/v1/notifications/* | NotificationHandlers | NotificationsController | JWT | Implemented |
| GET | /api/v1/routes | GetRoutesQuery | RoutesController | Public | Implemented |
| GET | /api/v1/routes/{id}/timeline | GetRouteTimelineQuery | RoutesController | Public | Implemented (stop list subset) |
| POST | /api/v1/customer-trips | CreateCustomerTripHandler | CustomerTripsController | Public | Implemented (410 deprecated) |
| GET | /api/v1/subscription-packages | SubscriptionQueries | RemainingApiController | Public | Implemented |
| GET | /api/v1/trips/me | GetUserTripsQuery | RemainingApiController | JWT | Implemented (shape may differ) |
| POST | /api/v1/trips/{id}/cancel | CancelTripBookingCommand | RemainingApiController | JWT | Partial (seat restore SQL) |
| GET | /api/v1/bookings/preview | GetBookingPreviewQuery | RemainingApiController | Public | Not fully ported (pricing) |
| POST | /api/v1/bookings | CreateBookingCommand | RemainingApiController | JWT | Not fully ported (501) |
| GET/POST | /api/v1/rides/* | RideHandlers | RemainingApiController | JWT | Partial |
| GET/POST | /api/v1/groups/* | GroupHandlers | — | JWT | Not Started |
| GET/POST | /api/v1/drivers/me/* | Driver*Handlers | — | JWT + 12/min trips GET | Not Started |
| * | /api/v1/admin/* (fleet, demand, pricing, trips generate, …) | Admin*Handlers | Dashboard + users list only | AdminOnly | Partial |

SignalR: `/hubs/trip-tracking`, `/hubs/support-chat`, `/hubs/driver` — **Not Started** (Nest gateways pending).

Full .NET action-level inventory was taken from all 41 controller classes during review.
