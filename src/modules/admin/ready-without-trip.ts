import { UPCOMING_TRIP_STATUSES } from './operations-metrics';

export type LaunchEligibleCorridor = {
  launchStatus?: string | null;
  pricingLinked?: boolean | null;
  routeId?: string | null;
};

export type TripRouteFact = {
  routeId: string;
  status: number;
  scheduledAt: Date;
  isDeleted?: boolean;
};

export function isLaunchEligibleCorridor(row: LaunchEligibleCorridor): boolean {
  return (
    !!row.routeId &&
    row.pricingLinked === true &&
    String(row.launchStatus || '').toUpperCase() === 'READY'
  );
}

export function isUpcomingTripFact(trip: TripRouteFact, now: Date): boolean {
  return (
    trip.isDeleted !== true &&
    UPCOMING_TRIP_STATUSES.includes(trip.status as (typeof UPCOMING_TRIP_STATUSES)[number]) &&
    trip.scheduledAt.getTime() >= now.getTime()
  );
}

/** Unique official route IDs that are launch-eligible and have no upcoming Trip.routeId match. */
export function countReadyRoutesWithoutUpcomingTrip(
  corridors: LaunchEligibleCorridor[],
  trips: TripRouteFact[],
  now: Date,
): number {
  const upcomingRouteIds = new Set(
    trips.filter((trip) => isUpcomingTripFact(trip, now)).map((trip) => trip.routeId),
  );
  const readyRouteIds = [
    ...new Set(
      corridors.filter(isLaunchEligibleCorridor).map((row) => row.routeId as string),
    ),
  ];
  return readyRouteIds.filter((routeId) => !upcomingRouteIds.has(routeId)).length;
}
