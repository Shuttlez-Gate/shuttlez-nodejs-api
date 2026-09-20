# Migration status

Do not mark Complete until tested against the same request/DB behavior as .NET.

| Module | Reviewed | Implemented | Tested | API Verified | Status |
| ------ | -------- | ----------- | ------ | ------------ | ------ |
| Health | Yes | Yes | Yes | No | Testing |
| Auth (OTP/JWT/refresh/register) | Yes | Yes | Partial | No | Implemented |
| Social auth (Firebase) | Yes | Yes | No | No | Implemented |
| Users /me | Yes | Yes | No | No | Implemented |
| Admin auth | Yes | Yes | No | No | Implemented |
| Content FAQ/legal | Yes | Yes | No | No | Implemented |
| Landing leads/waitlist/captains | Yes | Yes | No | No | Implemented |
| Saved locations | Yes | Yes | No | No | Implemented |
| Notifications + devices | Yes | Yes | No | No | Implemented |
| Routes list/timeline | Yes | Partial | No | No | In Progress |
| Customer-trips (410) | Yes | Yes | No | No | Implemented |
| Subscriptions | Yes | Yes | No | No | Implemented |
| Trips me/details/cancel | Yes | Yes | No | No | Implemented |
| Bookings preview/create | Yes | Yes | No | No | Implemented (preview matches origin/destination for captain routes; empty 200) |
| FCM push | Yes | Yes | No | No | Implemented (UserDevice + Notification persist; send via firebase-admin) |
| Captain routes marketplace | Yes | Yes | No | No | Implemented (schema SQL additive; captain APIs; segment lock; admin cancellation) |
| Rides | Yes | Yes | No | No | Implemented |
| Groups | Yes | Yes | No | No | Implemented |
| Drivers / captain lifecycle | Yes | Yes | No | No | Implemented |
| Support | Yes | Yes | No | No | Implemented |
| Admin dashboard/users | Yes | Yes | No | No | Implemented |
| Admin fleet/routes/trips/demand/pricing | Yes | Yes | No | No | Implemented (demand launch simplified) |
| SignalR hubs | Yes | Partial | No | No | Socket.IO on same paths |
| Google Directions | Yes | Config only | No | No | Haversine fallback |
| File uploads KYC | Yes | Yes | No | No | Implemented (local/tmp disk) |

All **172 HTTP endpoints** from the .NET controllers now have Nest routes. Contract tests against live .NET are still pending.
