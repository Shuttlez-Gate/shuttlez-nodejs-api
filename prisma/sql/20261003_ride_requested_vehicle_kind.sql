-- Stores the vehicle the rider asked for (scooter, private car, …)
-- so trip history can show a reserved ride before a captain is assigned.
-- Additive. Safe to re-run.

ALTER TABLE "RideRequestsSet"
  ADD COLUMN IF NOT EXISTS "RequestedVehicleKind" varchar(40);
