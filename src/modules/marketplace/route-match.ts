import { MATCH_RADIUS_METERS, matchOriginDestination, type OrderedStop } from './segment-occupancy';
import { cairoDateKey } from '../bookings/rider-history-bucket';

export type JourneyQuery = {
  fromLatitude?: number | null;
  fromLongitude?: number | null;
  toLatitude?: number | null;
  toLongitude?: number | null;
  fromAddress?: string | null;
  toAddress?: string | null;
};

export function normalizePlaceName(raw?: string | null): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A stop serves a requested place only when the names actually refer to the same place. */
export function placesCompatible(requested?: string | null, stopName?: string | null): boolean {
  const wanted = normalizePlaceName(requested);
  const stop = normalizePlaceName(stopName);
  if (wanted.length < 3 || stop.length < 3) return false;
  if (wanted === stop) return true;
  const shorter = wanted.length <= stop.length ? wanted : stop;
  const longer = wanted.length <= stop.length ? stop : wanted;
  if (shorter.length < 4) return false;
  return longer.includes(shorter);
}

export function hasJourneyCoordinates(query: JourneyQuery): boolean {
  const values = [
    query.fromLatitude,
    query.fromLongitude,
    query.toLatitude,
    query.toLongitude,
  ];
  return values.every((value) => typeof value === 'number' && Number.isFinite(value));
}

export function journeyRequested(query: JourneyQuery): boolean {
  if (hasJourneyCoordinates(query)) return true;
  return (
    normalizePlaceName(query.fromAddress).length >= 3 ||
    normalizePlaceName(query.toAddress).length >= 3
  );
}

/**
 * Origin must match an earlier stop than destination.
 * Coordinates use the existing 600m stop radius.
 * Names are used only when coordinates were not sent, and both ends must match.
 */
export function matchRouteToJourney(
  stops: OrderedStop[],
  query: JourneyQuery,
): { origin: OrderedStop; destination: OrderedStop } | null {
  const ordered = [...stops].sort((a, b) => a.order - b.order);
  if (ordered.length < 2) return null;
  if (hasJourneyCoordinates(query)) {
    return matchOriginDestination(
      ordered,
      query.fromLatitude as number,
      query.fromLongitude as number,
      query.toLatitude as number,
      query.toLongitude as number,
      MATCH_RADIUS_METERS,
    );
  }
  const from = normalizePlaceName(query.fromAddress);
  const to = normalizePlaceName(query.toAddress);
  if (from.length < 3 || to.length < 3) return null;
  const origin = ordered.find((stop) => placesCompatible(from, stop.name));
  if (!origin) return null;
  const destination = ordered.find(
    (stop) => stop.order > origin.order && placesCompatible(to, stop.name),
  );
  if (!destination) return null;
  return { origin, destination };
}

export function instancesOnDate<T extends { scheduledAt: Date }>(
  trips: T[],
  dateKey: string,
): T[] {
  const key = dateKey.trim();
  return trips.filter((trip) => cairoDateKey(trip.scheduledAt) === key);
}
