CREATE TABLE "RideOfferDecisionsSet" (
  "Id" UUID NOT NULL,
  "RideId" UUID NOT NULL,
  "DriverId" UUID NOT NULL,
  "Decision" VARCHAR(20) NOT NULL,
  "DecidedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PK_RideOfferDecisionsSet" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_RideOfferDecisionsSet_Decision" CHECK ("Decision" = 'rejected'),
  CONSTRAINT "FK_RideOfferDecisionsSet_RideRequestsSet_RideId"
    FOREIGN KEY ("RideId") REFERENCES "RideRequestsSet"("Id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "FK_RideOfferDecisionsSet_DriversSet_DriverId"
    FOREIGN KEY ("DriverId") REFERENCES "DriversSet"("Id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UX_RideOfferDecisionsSet_Ride_Driver"
  ON "RideOfferDecisionsSet"("RideId", "DriverId");
CREATE INDEX "IX_RideOfferDecisionsSet_Driver_Decision_Date"
  ON "RideOfferDecisionsSet"("DriverId", "Decision", "DecidedAt");

CREATE TABLE "RideCashCollectionsSet" (
  "Id" UUID NOT NULL,
  "RideId" UUID NOT NULL,
  "DriverId" UUID NOT NULL,
  "Amount" DECIMAL(18,2) NOT NULL,
  "Currency" VARCHAR(8) NOT NULL DEFAULT 'EGP',
  "CollectedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PK_RideCashCollectionsSet" PRIMARY KEY ("Id"),
  CONSTRAINT "FK_RideCashCollectionsSet_RideRequestsSet_RideId"
    FOREIGN KEY ("RideId") REFERENCES "RideRequestsSet"("Id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "FK_RideCashCollectionsSet_DriversSet_DriverId"
    FOREIGN KEY ("DriverId") REFERENCES "DriversSet"("Id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UX_RideCashCollectionsSet_RideId"
  ON "RideCashCollectionsSet"("RideId");
CREATE INDEX "IX_RideCashCollectionsSet_Driver_Date"
  ON "RideCashCollectionsSet"("DriverId", "CollectedAt");

CREATE TABLE "OutboxEventsSet" (
  "Id" UUID NOT NULL,
  "EventType" VARCHAR(80) NOT NULL,
  "AggregateId" UUID NOT NULL,
  "Payload" JSONB NOT NULL,
  "Status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "AttemptCount" INTEGER NOT NULL DEFAULT 0,
  "NextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "ProcessingStartedAt" TIMESTAMPTZ(6),
  "LastError" VARCHAR(2000),
  "DeliveredAt" TIMESTAMPTZ(6),
  "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "PK_OutboxEventsSet" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_OutboxEventsSet_Status" CHECK ("Status" IN ('pending', 'processing', 'delivered'))
);
CREATE INDEX "IX_OutboxEventsSet_Pending"
  ON "OutboxEventsSet"("Status", "NextAttemptAt", "CreatedAt");
