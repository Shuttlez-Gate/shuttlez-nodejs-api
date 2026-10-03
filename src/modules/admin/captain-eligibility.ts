import { PrismaService } from '../../database/prisma/prisma.service';
import { ErrorCodes } from '../../common/error-codes';
import { AppException } from '../../common/exceptions/app.exception';
import { GroupRequestStatus, RideRequestStatus, TripStatus } from '../../common/enums';
import {
  captainVehicleKind,
  vehicleKindsCompatible,
} from '../../common/utils/enums-map';

export const DEFAULT_ASSIGNMENT_WINDOW_MS = 2 * 60 * 60 * 1000;

const ACTIVE_TRIP_STATUSES: number[] = [
  TripStatus.Scheduled,
  TripStatus.DriverAssigned,
  TripStatus.InProgress,
];

const ACTIVE_RIDE_STATUSES: number[] = [
  RideRequestStatus.Assigned,
  RideRequestStatus.InProgress,
];

const ACTIVE_GROUP_STATUSES: number[] = [
  GroupRequestStatus.Assigned,
  GroupRequestStatus.InProgress,
];

export function assignmentWindowMs(durationSeconds?: number | null): number {
  if (durationSeconds && durationSeconds > 0) {
    return durationSeconds * 1000;
  }
  return DEFAULT_ASSIGNMENT_WINDOW_MS;
}

export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export async function assertCaptainEligible(
  prisma: PrismaService,
  opts: {
    driverId: string;
    requiredVehicleKind?: string | null;
    at: Date;
    durationSeconds?: number | null;
    excludeTripId?: string | null;
    excludeRideId?: string | null;
    excludeGroupId?: string | null;
  },
): Promise<void> {
  const driver = await prisma.driver.findFirst({
    where: { id: opts.driverId, isDeleted: false, isActive: true },
    include: { vehicle: true },
  });
  if (!driver) {
    throw new AppException('الكابتن غير موجود أو غير نشط', 404, ErrorCodes.DriverNotFound);
  }

  const kind = captainVehicleKind(driver);
  if (!vehicleKindsCompatible(opts.requiredVehicleKind, kind)) {
    throw new AppException(
      'نوع مركبة الكابتن لا يطابق نوع الرحلة',
      400,
      ErrorCodes.DriverNotEligible,
    );
  }

  const windowMs = assignmentWindowMs(opts.durationSeconds);
  const start = opts.at;
  const end = new Date(start.getTime() + windowMs);

  const trips = await prisma.trip.findMany({
    where: {
      isDeleted: false,
      driverId: driver.id,
      status: { in: ACTIVE_TRIP_STATUSES },
      ...(opts.excludeTripId ? { id: { not: opts.excludeTripId } } : {}),
    },
    include: { route: { select: { durationSeconds: true } } },
  });
  const tripConflict = trips.some((trip) => {
    const tripEnd = new Date(
      trip.scheduledAt.getTime() + assignmentWindowMs(trip.route.durationSeconds),
    );
    return intervalsOverlap(start, end, trip.scheduledAt, tripEnd);
  });
  if (tripConflict) {
    throw new AppException(
      'الكابتن معيّن على رحلة أخرى في نفس الوقت',
      409,
      ErrorCodes.DriverTripConflict,
    );
  }

  const rides = await prisma.rideRequest.findMany({
    where: {
      isDeleted: false,
      driverId: driver.id,
      status: { in: ACTIVE_RIDE_STATUSES },
      ...(opts.excludeRideId ? { id: { not: opts.excludeRideId } } : {}),
    },
  });
  const rideConflict = rides.some((ride) => {
    const rideStart = ride.scheduledFor ?? ride.startedAt ?? ride.assignedAt ?? ride.createdAt;
    const rideEnd = new Date(rideStart.getTime() + DEFAULT_ASSIGNMENT_WINDOW_MS);
    return intervalsOverlap(start, end, rideStart, rideEnd);
  });
  if (rideConflict) {
    throw new AppException(
      'الكابتن معيّن على مشوار آخر في نفس الوقت',
      409,
      ErrorCodes.DriverRideConflict,
    );
  }

  const groups = await prisma.groupRequest.findMany({
    where: {
      isDeleted: false,
      driverId: driver.id,
      status: { in: ACTIVE_GROUP_STATUSES },
      ...(opts.excludeGroupId ? { id: { not: opts.excludeGroupId } } : {}),
    },
  });
  const groupConflict = groups.some((group) => {
    const groupStart = group.startedAt ?? group.assignedAt ?? group.createdAt;
    const groupEnd = new Date(groupStart.getTime() + DEFAULT_ASSIGNMENT_WINDOW_MS);
    return intervalsOverlap(start, end, groupStart, groupEnd);
  });
  if (groupConflict) {
    throw new AppException(
      'الكابتن معيّن على مجموعة أخرى في نفس الوقت',
      409,
      ErrorCodes.DriverGroupConflict,
    );
  }
}
