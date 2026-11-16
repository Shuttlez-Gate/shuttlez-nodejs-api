CREATE TABLE IF NOT EXISTS "CaptainCommissionPaymentsSet" (
  "Id" uuid NOT NULL,
  "DriverId" uuid NOT NULL,
  "Amount" numeric(18,2) NOT NULL,
  "SenderPhone" varchar(20) NOT NULL,
  "ReceiptStorage" text NOT NULL,
  "Status" integer NOT NULL,
  "ConfirmedAt" timestamptz(6),
  "ConfirmedByUserId" uuid,
  "CreatedAt" timestamptz(6) NOT NULL,
  "UpdatedAt" timestamptz(6),
  "IsDeleted" boolean NOT NULL,
  CONSTRAINT "PK_CaptainCommissionPaymentsSet" PRIMARY KEY ("Id"),
  CONSTRAINT "FK_CaptainCommissionPaymentsSet_DriversSet_DriverId"
    FOREIGN KEY ("DriverId") REFERENCES "DriversSet"("Id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "IX_CaptainCommissionPaymentsSet_DriverId"
  ON "CaptainCommissionPaymentsSet"("DriverId");

CREATE INDEX IF NOT EXISTS "IX_CaptainCommissionPaymentsSet_Status_CreatedAt"
  ON "CaptainCommissionPaymentsSet"("Status", "CreatedAt");
