import {
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import { cairoDateKey } from './rider-history-bucket';

/** Midnight in Africa/Cairo, as a UTC instant. Egypt is UTC+2 year round. */
export function cairoStartOfDayUtc(now = new Date()): Date {
  const [year, month, day] = cairoDateKey(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 2 * 60 * 60 * 1000);
}

/** One sweep per minute. The rule only moves rows onto a previous Cairo day. */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;
let pendingSweep: Promise<void> | null = null;

/**
 * Appointments on a previous Cairo day cannot stay open.
 * A request or draft that never moved forward is cancelled.
 * A confirmed, assigned, or in-progress trip is completed.
 * The five updates run as one statement so a remote database pays one round trip.
 */
export async function closeElapsedHistory(
  prisma: PrismaService,
  now = new Date(),
): Promise<void> {
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  if (pendingSweep) return pendingSweep;
  pendingSweep = applyClose(prisma, now)
    .then(() => {
      lastSweepAt = Date.now();
    })
    .finally(() => {
      pendingSweep = null;
    });
  return pendingSweep;
}

async function applyClose(prisma: PrismaService, now: Date): Promise<void> {
  const start = cairoStartOfDayUtc(now);
  await prisma.$queryRaw`
    WITH trips AS (
      UPDATE "TripsSet"
      SET "Status" = ${TripStatus.Completed},
          "CompletedAt" = ${now},
          "UpdatedAt" = ${now}
      WHERE "IsDeleted" = false
        AND "Status" IN (
          ${TripStatus.Scheduled},
          ${TripStatus.DriverAssigned},
          ${TripStatus.InProgress}
        )
        AND "ScheduledAt" < ${start}
      RETURNING 1
    ),
    rides AS (
      UPDATE "RideRequestsSet"
      SET "Status" = CASE
            WHEN "Status" = ${RideRequestStatus.Requested} THEN ${RideRequestStatus.Cancelled}
            ELSE ${RideRequestStatus.Completed}
          END,
          "CancelledAt" = CASE
            WHEN "Status" = ${RideRequestStatus.Requested} THEN ${now}
            ELSE "CancelledAt"
          END,
          "CompletedAt" = CASE
            WHEN "Status" = ${RideRequestStatus.Requested} THEN "CompletedAt"
            ELSE ${now}
          END,
          "UpdatedAt" = ${now}
      WHERE "IsDeleted" = false
        AND "Status" IN (
          ${RideRequestStatus.Requested},
          ${RideRequestStatus.Assigned},
          ${RideRequestStatus.InProgress}
        )
        AND (
          "ScheduledFor" < ${start}
          OR ("ScheduledFor" IS NULL AND "CreatedAt" < ${start})
        )
      RETURNING 1
    ),
    groups AS (
      UPDATE "GroupRequestsSet"
      SET "Status" = CASE
            WHEN "Status" = ${GroupRequestStatus.Draft} THEN ${GroupRequestStatus.Cancelled}
            ELSE ${GroupRequestStatus.Completed}
          END,
          "CancelledAt" = CASE
            WHEN "Status" = ${GroupRequestStatus.Draft} THEN ${now}
            ELSE "CancelledAt"
          END,
          "CompletedAt" = CASE
            WHEN "Status" = ${GroupRequestStatus.Draft} THEN "CompletedAt"
            ELSE ${now}
          END,
          "UpdatedAt" = ${now}
      WHERE "IsDeleted" = false
        AND "Status" IN (
          ${GroupRequestStatus.Draft},
          ${GroupRequestStatus.Confirmed},
          ${GroupRequestStatus.Assigned},
          ${GroupRequestStatus.InProgress}
        )
        AND "CreatedAt" < ${start}
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*) FROM trips) AS trips,
      (SELECT COUNT(*) FROM rides) AS rides,
      (SELECT COUNT(*) FROM groups) AS groups
  `;
}
