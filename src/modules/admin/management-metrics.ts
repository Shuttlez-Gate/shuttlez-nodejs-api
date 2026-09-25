import { TripStatus } from '../../common/enums';
import {
  isCountableConfirmedBooking,
  isUpcomingTripSnapshot,
  occupancyPercent,
  tripCapacity,
} from './operations-metrics';
import { isLaunchEligibleCorridor, type LaunchEligibleCorridor } from './ready-without-trip';

export type OccupancyTotals = {
  confirmedSeats: number;
  remainingSeats: number;
  capacity: number | null;
  occupancyPercent: number | null;
  tripCount: number;
  tripsWithConfirmedSeats: number;
};

export function occupancyFromAggregates(
  confirmedSeatSum: number,
  remainingSeatSum: number,
  tripCount = 0,
  tripsWithConfirmedSeats = 0,
): OccupancyTotals {
  const confirmedSeats = Number(confirmedSeatSum) || 0;
  const remainingSeats = Number(remainingSeatSum) || 0;
  return {
    confirmedSeats,
    remainingSeats,
    capacity: tripCapacity(remainingSeats, confirmedSeats),
    occupancyPercent: occupancyPercent(confirmedSeats, remainingSeats),
    tripCount,
    tripsWithConfirmedSeats,
  };
}

export function upcomingAssignedCount(upcomingTotal: number, upcomingUnassigned: number): number {
  return Math.max(0, (Number(upcomingTotal) || 0) - (Number(upcomingUnassigned) || 0));
}

export type RouteOperationTrip = {
  id: string;
  routeId: string;
  status: number;
  scheduledAt: Date;
  driverId?: string | null;
  availableSeats: number;
  isDeleted?: boolean;
};

export type RouteOperationBooking = {
  tripId: string;
  status: number;
  seatCount: number;
  totalAmount: number;
  isDeleted?: boolean;
};

export type OfficialRouteOperations = {
  routeId: string;
  tripCount: number;
  upcomingTripCount: number;
  upcomingUnassignedCount: number;
  completedTripCount: number;
  confirmedBookingCount: number;
  confirmedSeatCount: number;
  confirmedRevenue: number;
  occupancyPercent: number | null;
};

/** Factual route totals using Trip.routeId only. Unrelated trips are ignored. */
export function summarizeOfficialRouteOperations(
  routeId: string,
  trips: RouteOperationTrip[],
  bookings: RouteOperationBooking[],
  now: Date,
): OfficialRouteOperations {
  const routeTrips = trips.filter((trip) => trip.routeId === routeId && trip.isDeleted !== true);
  const tripIds = new Set(routeTrips.map((trip) => trip.id));
  const remaining = routeTrips.reduce((sum, trip) => sum + (Number(trip.availableSeats) || 0), 0);
  const confirmed = bookings.filter(
    (row) => tripIds.has(row.tripId) && isCountableConfirmedBooking(row),
  );
  const confirmedSeatCount = confirmed.reduce((sum, row) => sum + (row.seatCount || 0), 0);
  return {
    routeId,
    tripCount: routeTrips.length,
    upcomingTripCount: routeTrips.filter((trip) =>
      isUpcomingTripSnapshot(trip.status, trip.scheduledAt, now, trip.isDeleted),
    ).length,
    upcomingUnassignedCount: routeTrips.filter(
      (trip) =>
        isUpcomingTripSnapshot(trip.status, trip.scheduledAt, now, trip.isDeleted) && !trip.driverId,
    ).length,
    completedTripCount: routeTrips.filter((trip) => trip.status === TripStatus.Completed).length,
    confirmedBookingCount: confirmed.length,
    confirmedSeatCount,
    confirmedRevenue: confirmed.reduce((sum, row) => sum + (row.totalAmount || 0), 0),
    occupancyPercent: occupancyPercent(confirmedSeatCount, remaining),
  };
}

export type LaunchPipelineSnapshot = {
  readyCorridors: number;
  readyCorridorsWithoutUpcomingTrip: number;
  readyCorridorsWithUpcomingTrip: number;
  corridorsWithoutPricing: number;
};

export function summarizeLaunchPipeline(
  corridors: Array<LaunchEligibleCorridor & { pricingAvailable?: boolean | null }>,
  upcomingRouteIds: string[],
): LaunchPipelineSnapshot {
  const readyIds = [
    ...new Set(
      corridors.filter(isLaunchEligibleCorridor).map((row) => row.routeId as string),
    ),
  ];
  const upcoming = new Set(upcomingRouteIds);
  const readyWithUpcoming = readyIds.filter((id) => upcoming.has(id)).length;
  return {
    readyCorridors: readyIds.length,
    readyCorridorsWithUpcomingTrip: readyWithUpcoming,
    readyCorridorsWithoutUpcomingTrip: readyIds.length - readyWithUpcoming,
    corridorsWithoutPricing: corridors.filter((row) => row.pricingAvailable === false).length,
  };
}

export function isPeriodConfirmedRevenueRow(row: {
  status: number;
  isDeleted?: boolean;
}): boolean {
  return isCountableConfirmedBooking(row);
}
