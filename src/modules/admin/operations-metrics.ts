import { BookingStatus, GroupRequestStatus, RideRequestStatus, TripStatus } from '../../common/enums';

/** Authoritative confirmed shuttle booking. No Rejected status exists in BookingStatus. */
export const CONFIRMED_BOOKING_STATUS = BookingStatus.Confirmed;

export const confirmedBookingWhere = {
  isDeleted: false,
  status: BookingStatus.Confirmed,
} as const;

/**
 * TripStatus.DriverAssigned means a captain was assigned.
 * The assignment queue is Scheduled trips with no driverId.
 * Completed/Cancelled are historical and never an assignment queue item.
 */
export const NEEDS_CAPTAIN_STATUSES: TripStatus[] = [TripStatus.Scheduled];

export const UPCOMING_TRIP_STATUSES: TripStatus[] = [
  TripStatus.Scheduled,
  TripStatus.DriverAssigned,
];

export function upcomingTripsWhere(now: Date) {
  return {
    isDeleted: false,
    status: { in: UPCOMING_TRIP_STATUSES },
    scheduledAt: { gte: now },
  } as const;
}

/** Upcoming shuttle trip that still needs a captain. Past Scheduled trips are not in this queue. */
export function upcomingUnassignedTripsWhere(now: Date) {
  return {
    isDeleted: false,
    driverId: null,
    status: TripStatus.Scheduled,
    scheduledAt: { gte: now },
  } as const;
}

export function ridesNeedingCaptainWhere() {
  return {
    isDeleted: false,
    driverId: null,
    status: RideRequestStatus.Requested,
  } as const;
}

export function groupsNeedingCaptainWhere() {
  return {
    isDeleted: false,
    driverId: null,
    status: { in: [GroupRequestStatus.Draft, GroupRequestStatus.Confirmed] as number[] },
  };
}

export function completedTripsInPeriodWhere(start: Date, end: Date) {
  return {
    isDeleted: false,
    status: TripStatus.Completed,
    scheduledAt: { gte: start, lt: end },
  } as const;
}

export type BookingFinanceRow = {
  status: number;
  seatCount: number;
  totalAmount: number;
  commissionAmount: number;
  captainEarnings: number;
  isDeleted?: boolean;
};

export function isConfirmedBookingStatus(status: number): boolean {
  return status === BookingStatus.Confirmed;
}

export function isCountableConfirmedBooking(row: {
  status: number;
  isDeleted?: boolean;
}): boolean {
  return row.isDeleted !== true && isConfirmedBookingStatus(row.status);
}

/**
 * Invalid values (`abc`, `xyz`) are ignored, not treated as true.
 * Matches existing Admin query-parameter convention: safely ignore unknown flags.
 */
export function parseOptionalBoolean(raw?: string | null): boolean | undefined {
  if (raw == null || raw === '') {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no'].includes(value)) {
    return false;
  }
  return undefined;
}

export function isUnassignedDriver(driverId: string | null | undefined): boolean {
  return driverId == null || driverId === '';
}

export function needsCaptainAssignment(
  driverId: string | null | undefined,
  status: number,
): boolean {
  return isUnassignedDriver(driverId) && NEEDS_CAPTAIN_STATUSES.includes(status as TripStatus);
}

export function driverAssignedWhere(
  driverAssigned?: boolean,
): { driverId: null } | { driverId: { not: null } } | undefined {
  if (driverAssigned === false) {
    return { driverId: null };
  }
  if (driverAssigned === true) {
    return { driverId: { not: null } };
  }
  return undefined;
}

/**
 * availableSeats is remaining inventory after confirmed bookings
 * (decrement on confirm, restore on cancel). Capacity is remaining + occupied.
 */
export function tripCapacity(
  availableSeats: number,
  confirmedSeatCount: number,
): number | null {
  const remaining = Number(availableSeats) || 0;
  const occupied = Number(confirmedSeatCount) || 0;
  const capacity = remaining + occupied;
  return capacity > 0 ? capacity : null;
}

/**
 * Confirmed occupancy percent, one decimal.
 * Formula: confirmed booked seats / (availableSeats + confirmed booked seats).
 * Returns null when capacity cannot be determined.
 */
export function occupancyPercent(
  confirmedSeatCount: number,
  availableSeats: number,
): number | null {
  const capacity = tripCapacity(availableSeats, confirmedSeatCount);
  if (capacity == null) {
    return null;
  }
  return Math.round((confirmedSeatCount * 1000) / capacity) / 10;
}

export function summarizeConfirmedBookings(bookings: BookingFinanceRow[]) {
  const confirmed = bookings.filter((row) => isCountableConfirmedBooking(row));
  return {
    confirmedBookingCount: confirmed.length,
    confirmedSeatCount: confirmed.reduce((sum, row) => sum + (row.seatCount || 0), 0),
    confirmedRevenue: confirmed.reduce((sum, row) => sum + (row.totalAmount || 0), 0),
    confirmedCommission: confirmed.reduce((sum, row) => sum + (row.commissionAmount || 0), 0),
    confirmedCaptainEarnings: confirmed.reduce(
      (sum, row) => sum + (row.captainEarnings || 0),
      0,
    ),
  };
}

/** Non-deleted booking counts by status. Pending/Cancelled/Expired are not confirmed occupancy. */
export function summarizeBookingStatusCounts(
  bookings: Array<{ status: number; isDeleted?: boolean }>,
) {
  const live = bookings.filter((row) => row.isDeleted !== true);
  const count = (status: number) => live.filter((row) => row.status === status).length;
  return {
    pendingBookingCount: count(BookingStatus.Pending),
    confirmedBookingCount: count(BookingStatus.Confirmed),
    cancelledBookingCount: count(BookingStatus.Cancelled),
    expiredBookingCount: count(BookingStatus.Expired),
  };
}

export function isUpcomingTripSnapshot(
  status: number,
  scheduledAt: Date,
  now: Date,
  isDeleted = false,
): boolean {
  return (
    isDeleted !== true &&
    UPCOMING_TRIP_STATUSES.includes(status as (typeof UPCOMING_TRIP_STATUSES)[number]) &&
    scheduledAt.getTime() >= now.getTime()
  );
}

export type UpcomingTripIndexRow = {
  id: string;
  routeId: string;
  scheduledAt: Date;
  driverId: string | null;
};

export type UpcomingTripRouteIndex = {
  id: string;
  scheduledAt: Date;
  driverId: string | null;
  count: number;
  unassignedCount: number;
};

/** One grouped query result: count all upcoming trips per official routeId. */
export function indexUpcomingTripsByRoute(
  trips: UpcomingTripIndexRow[],
): Map<string, UpcomingTripRouteIndex> {
  const byRoute = new Map<string, UpcomingTripRouteIndex>();
  for (const trip of trips) {
    const current = byRoute.get(trip.routeId);
    if (!current) {
      byRoute.set(trip.routeId, {
        id: trip.id,
        scheduledAt: trip.scheduledAt,
        driverId: trip.driverId,
        count: 1,
        unassignedCount: trip.driverId ? 0 : 1,
      });
    } else {
      current.count += 1;
      if (!trip.driverId) current.unassignedCount += 1;
    }
  }
  return byRoute;
}
