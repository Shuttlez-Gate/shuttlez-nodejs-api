import {
  MATCH_RADIUS_METERS,
  PREVIEW_MATCH_RADIUS_METERS,
  matchOriginDestination,
  type OrderedStop,
} from './segment-occupancy';
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

const LATIN_PLACE_ALIASES: Record<string, string> = {
  helwan: 'حلوان',
  shorouk: 'الشروق',
  'el shorouk': 'الشروق',
  'al shorouk': 'الشروق',
  'nasr city': 'مدينه نصر',
  'madinet nasr': 'مدينه نصر',
  maadi: 'المعادي',
  'new cairo': 'القاهره الجديده',
  rehab: 'الرحاب',
  mokattam: 'المقطم',
  heliopolis: 'مصر الجديده',
  'ain shams': 'عين شمس',
  shubra: 'شبرا',
  october: 'اكتوبر',
  'sheikh zayed': 'الشيخ زايد',
  obour: 'العبور',
  'new capital': 'العاصمه الاداريه',
};

function aliasedPlace(raw?: string | null): string {
  const key = normalizePlaceName(raw);
  if (!key) return '';
  if (LATIN_PLACE_ALIASES[key]) return LATIN_PLACE_ALIASES[key];
  for (const [latin, arabic] of Object.entries(LATIN_PLACE_ALIASES)) {
    if (key.includes(latin)) return arabic;
  }
  return key;
}

function namesOverlap(left: string, right: string): boolean {
  if (left.length < 3 || right.length < 3) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 4) return false;
  return longer.includes(shorter);
}

/** A stop serves a requested place only when the names actually refer to the same place. */
export function placesCompatible(requested?: string | null, stopName?: string | null): boolean {
  const wanted = normalizePlaceName(requested);
  const stop = normalizePlaceName(stopName);
  if (namesOverlap(wanted, stop)) return true;
  return namesOverlap(aliasedPlace(requested), aliasedPlace(stopName));
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
/**
 * Booking preview: a pin within 600m wins.
 * If the pin is farther, the written place names can still match the stop
 * (حلوان → مدينة نصر is often kilometers from the stored stop pin).
 */
export function matchPreviewStops(
  stops: OrderedStop[],
  query: JourneyQuery,
): { origin: OrderedStop; destination: OrderedStop } | null {
  const ordered = [...stops].sort((a, b) => a.order - b.order);
  if (hasJourneyCoordinates(query)) {
    const byCoords = matchStopsByRadius(ordered, query, MATCH_RADIUS_METERS)
      ?? matchStopsByRadius(ordered, query, PREVIEW_MATCH_RADIUS_METERS);
    if (byCoords) return byCoords;
  }
  return matchRouteToJourney(ordered, {
    fromAddress: query.fromAddress,
    toAddress: query.toAddress,
  });
}

export function matchRouteToJourney(
  stops: OrderedStop[],
  query: JourneyQuery,
): { origin: OrderedStop; destination: OrderedStop } | null {
  const ordered = [...stops].sort((a, b) => a.order - b.order);
  if (ordered.length < 2) return null;
  if (hasJourneyCoordinates(query)) {
    return matchStopsByRadius(ordered, query, MATCH_RADIUS_METERS)
      ?? matchStopsByRadius(ordered, query, PREVIEW_MATCH_RADIUS_METERS);
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

function matchStopsByRadius(
  stops: OrderedStop[],
  query: JourneyQuery,
  radiusMeters: number,
) {
  return matchOriginDestination(
    stops,
    query.fromLatitude as number,
    query.fromLongitude as number,
    query.toLatitude as number,
    query.toLongitude as number,
    radiusMeters,
  );
}

export function instancesOnDate<T extends { scheduledAt: Date }>(
  trips: T[],
  dateKey: string,
): T[] {
  const key = dateKey.trim();
  return trips.filter((trip) => cairoDateKey(trip.scheduledAt) === key);
}
