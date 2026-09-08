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
| Subscriptions | Yes | Partial | No | No | In Progress |
| Trips me/details/cancel | Yes | Partial | No | No | In Progress |
| Bookings preview/create | Yes | No | No | No | Requires Review |
| Rides | Yes | Partial | No | No | In Progress |
| Groups | Yes | No | No | No | Not Started |
| Drivers / captain lifecycle | Yes | No | No | No | Not Started |
| Support | Yes | Partial | No | No | In Progress |
| Admin dashboard/users list | Yes | Partial | No | No | In Progress |
| Admin fleet/routes/trips/demand/pricing | Yes | No | No | No | Not Started |
| SignalR hubs | Yes | No | No | No | Not Started |
| Google Directions | Yes | Config only | No | No | Not Started |
| FCM push | Yes | No | No | No | Not Started |
| File uploads KYC | Yes | No | No | No | Not Started |

Existing Node folder was **empty** before this work (no prior Nest implementation to merge).
