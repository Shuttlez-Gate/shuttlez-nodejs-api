-- Route-based ride packages and manual InstaPay verification.
-- Additive only. Does not update, reset, or delete existing rows.
-- Apply to production only after explicit approval.

ALTER TABLE "SubscriptionPackagesSet"
  ADD COLUMN IF NOT EXISTS "RouteId" uuid,
  ADD COLUMN IF NOT EXISTS "Direction" varchar(16) NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS "VehicleKind" varchar(40);

CREATE INDEX IF NOT EXISTS "IX_SubscriptionPackagesSet_RouteId"
  ON "SubscriptionPackagesSet" ("RouteId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_SubscriptionPackagesSet_RoutesSet_RouteId'
  ) THEN
    ALTER TABLE "SubscriptionPackagesSet"
      ADD CONSTRAINT "FK_SubscriptionPackagesSet_RoutesSet_RouteId"
      FOREIGN KEY ("RouteId") REFERENCES "RoutesSet" ("Id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PackagePurchasesSet" (
  "Id" uuid NOT NULL,
  "UserId" uuid NOT NULL,
  "PackageId" uuid NOT NULL,
  "Amount" numeric(18,2) NOT NULL,
  "Currency" varchar(8) NOT NULL DEFAULT 'EGP',
  "PublicReference" varchar(40) NOT NULL,
  "Status" varchar(32) NOT NULL,
  "Provider" varchar(32) NOT NULL DEFAULT 'manual_instapay',
  "TransactionReference" varchar(128),
  "TransactionReferenceNormalized" varchar(128),
  "TransferredAt" timestamptz(6),
  "ScreenshotStorage" text,
  "SubmittedAt" timestamptz(6),
  "VerifiedAt" timestamptz(6),
  "VerifiedByUserId" uuid,
  "RejectionReason" text,
  "SubscriptionId" uuid,
  "CreatedAt" timestamptz(6) NOT NULL,
  "UpdatedAt" timestamptz(6),
  "IsDeleted" boolean NOT NULL DEFAULT false,
  CONSTRAINT "PK_PackagePurchasesSet" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UX_PackagePurchasesSet_PublicReference"
  ON "PackagePurchasesSet" ("PublicReference");
CREATE INDEX IF NOT EXISTS "IX_PackagePurchasesSet_UserId_CreatedAt"
  ON "PackagePurchasesSet" ("UserId", "CreatedAt");
CREATE INDEX IF NOT EXISTS "IX_PackagePurchasesSet_Status_CreatedAt"
  ON "PackagePurchasesSet" ("Status", "CreatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "UX_PackagePurchasesSet_TransactionReference"
  ON "PackagePurchasesSet" ("TransactionReferenceNormalized")
  WHERE "TransactionReferenceNormalized" IS NOT NULL AND "IsDeleted" = false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_PackagePurchasesSet_UsersSet_UserId'
  ) THEN
    ALTER TABLE "PackagePurchasesSet"
      ADD CONSTRAINT "FK_PackagePurchasesSet_UsersSet_UserId"
      FOREIGN KEY ("UserId") REFERENCES "UsersSet" ("Id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_PackagePurchasesSet_SubscriptionPackagesSet_PackageId'
  ) THEN
    ALTER TABLE "PackagePurchasesSet"
      ADD CONSTRAINT "FK_PackagePurchasesSet_SubscriptionPackagesSet_PackageId"
      FOREIGN KEY ("PackageId") REFERENCES "SubscriptionPackagesSet" ("Id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "UserSubscriptionsSet" (
  "Id" uuid NOT NULL,
  "UserId" uuid NOT NULL,
  "PackageId" uuid NOT NULL,
  "RouteId" uuid,
  "PurchaseId" uuid,
  "Status" varchar(24) NOT NULL,
  "Direction" varchar(16) NOT NULL DEFAULT 'both',
  "VehicleKind" varchar(40),
  "RidesTotal" integer NOT NULL,
  "RidesUsed" integer NOT NULL DEFAULT 0,
  "RidesReserved" integer NOT NULL DEFAULT 0,
  "ActivatedAt" timestamptz(6),
  "ExpiresAt" timestamptz(6),
  "CreatedAt" timestamptz(6) NOT NULL,
  "UpdatedAt" timestamptz(6),
  "IsDeleted" boolean NOT NULL DEFAULT false,
  CONSTRAINT "PK_UserSubscriptionsSet" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UX_UserSubscriptionsSet_PurchaseId"
  ON "UserSubscriptionsSet" ("PurchaseId")
  WHERE "PurchaseId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "IX_UserSubscriptionsSet_UserId_Status"
  ON "UserSubscriptionsSet" ("UserId", "Status");
CREATE INDEX IF NOT EXISTS "IX_UserSubscriptionsSet_RouteId"
  ON "UserSubscriptionsSet" ("RouteId");
CREATE INDEX IF NOT EXISTS "IX_UserSubscriptionsSet_PackageId"
  ON "UserSubscriptionsSet" ("PackageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_UserSubscriptionsSet_UsersSet_UserId'
  ) THEN
    ALTER TABLE "UserSubscriptionsSet"
      ADD CONSTRAINT "FK_UserSubscriptionsSet_UsersSet_UserId"
      FOREIGN KEY ("UserId") REFERENCES "UsersSet" ("Id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_UserSubscriptionsSet_SubscriptionPackagesSet_PackageId'
  ) THEN
    ALTER TABLE "UserSubscriptionsSet"
      ADD CONSTRAINT "FK_UserSubscriptionsSet_SubscriptionPackagesSet_PackageId"
      FOREIGN KEY ("PackageId") REFERENCES "SubscriptionPackagesSet" ("Id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_UserSubscriptionsSet_RoutesSet_RouteId'
  ) THEN
    ALTER TABLE "UserSubscriptionsSet"
      ADD CONSTRAINT "FK_UserSubscriptionsSet_RoutesSet_RouteId"
      FOREIGN KEY ("RouteId") REFERENCES "RoutesSet" ("Id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_UserSubscriptionsSet_PackagePurchasesSet_PurchaseId'
  ) THEN
    ALTER TABLE "UserSubscriptionsSet"
      ADD CONSTRAINT "FK_UserSubscriptionsSet_PackagePurchasesSet_PurchaseId"
      FOREIGN KEY ("PurchaseId") REFERENCES "PackagePurchasesSet" ("Id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PackagePaymentAuditsSet" (
  "Id" uuid NOT NULL,
  "PurchaseId" uuid NOT NULL,
  "ActorUserId" uuid,
  "Action" varchar(32) NOT NULL,
  "Note" text,
  "CreatedAt" timestamptz(6) NOT NULL,
  CONSTRAINT "PK_PackagePaymentAuditsSet" PRIMARY KEY ("Id")
);

CREATE INDEX IF NOT EXISTS "IX_PackagePaymentAuditsSet_PurchaseId_CreatedAt"
  ON "PackagePaymentAuditsSet" ("PurchaseId", "CreatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_PackagePaymentAuditsSet_PackagePurchasesSet_PurchaseId'
  ) THEN
    ALTER TABLE "PackagePaymentAuditsSet"
      ADD CONSTRAINT "FK_PackagePaymentAuditsSet_PackagePurchasesSet_PurchaseId"
      FOREIGN KEY ("PurchaseId") REFERENCES "PackagePurchasesSet" ("Id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_PackagePaymentAuditsSet_UsersSet_ActorUserId'
  ) THEN
    ALTER TABLE "PackagePaymentAuditsSet"
      ADD CONSTRAINT "FK_PackagePaymentAuditsSet_UsersSet_ActorUserId"
      FOREIGN KEY ("ActorUserId") REFERENCES "UsersSet" ("Id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "RidePackageReservationsSet" (
  "Id" uuid NOT NULL,
  "SubscriptionId" uuid NOT NULL,
  "BookingId" uuid NOT NULL,
  "Status" varchar(16) NOT NULL,
  "CreatedAt" timestamptz(6) NOT NULL,
  "UpdatedAt" timestamptz(6),
  "IsDeleted" boolean NOT NULL DEFAULT false,
  CONSTRAINT "PK_RidePackageReservationsSet" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UX_RidePackageReservationsSet_BookingId"
  ON "RidePackageReservationsSet" ("BookingId");
CREATE INDEX IF NOT EXISTS "IX_RidePackageReservationsSet_SubscriptionId_Status"
  ON "RidePackageReservationsSet" ("SubscriptionId", "Status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_RidePkgReservation_Subscription'
  ) THEN
    ALTER TABLE "RidePackageReservationsSet"
      ADD CONSTRAINT "FK_RidePkgReservation_Subscription"
      FOREIGN KEY ("SubscriptionId") REFERENCES "UserSubscriptionsSet" ("Id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_RidePackageReservationsSet_BookingsSet_BookingId'
  ) THEN
    ALTER TABLE "RidePackageReservationsSet"
      ADD CONSTRAINT "FK_RidePackageReservationsSet_BookingsSet_BookingId"
      FOREIGN KEY ("BookingId") REFERENCES "BookingsSet" ("Id") ON DELETE CASCADE;
  END IF;
END $$;
