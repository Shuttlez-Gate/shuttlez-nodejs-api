import { haversineKm, normalizeMoney } from '../../common/utils/money';

export const MATCH_RADIUS_METERS = 600;

export type OrderedStop = {
  id: string;
  order: number;
  latitude: number;
  longitude: number;
  name: string;
};

export type SegmentSeatRow = {
  fromOrder: number;
  toOrder: number;
  remainingSeats: number;
};

export function consecutiveSegmentKeys(
  fromOrder: number,
  toOrder: number,
): Array<{ fromOrder: number; toOrder: number }> {
  if (toOrder - fromOrder < 1) {
    return [];
  }
  const keys: Array<{ fromOrder: number; toOrder: number }> = [];
  for (let order = fromOrder; order < toOrder; order += 1) {
    keys.push({ fromOrder: order, toOrder: order + 1 });
  }
  return keys;
}

export function remainingForRange(
  segments: SegmentSeatRow[],
  fromOrder: number,
  toOrder: number,
): number {
  const keys = consecutiveSegmentKeys(fromOrder, toOrder);
  if (keys.length === 0) {
    return 0;
  }
  let min = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    const row = segments.find(
      (item) => item.fromOrder === key.fromOrder && item.toOrder === key.toOrder,
    );
    if (!row) {
      return 0;
    }
    min = Math.min(min, row.remainingSeats);
  }
  return min;
}

export function segmentPrice(
  fullPricePerSeat: number,
  fromOrder: number,
  toOrder: number,
  firstOrder: number,
  lastOrder: number,
): number {
  const fullSpan = lastOrder - firstOrder;
  const span = toOrder - fromOrder;
  if (fullSpan <= 0 || span <= 0) {
    return normalizeMoney(fullPricePerSeat);
  }
  return normalizeMoney(fullPricePerSeat * (span / fullSpan));
}

export function nearestStop(
  stops: OrderedStop[],
  latitude: number,
  longitude: number,
  radiusMeters = MATCH_RADIUS_METERS,
): OrderedStop | null {
  let best: OrderedStop | null = null;
  let bestMeters = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const meters =
      haversineKm(latitude, longitude, stop.latitude, stop.longitude) * 1000;
    if (meters <= radiusMeters && meters < bestMeters) {
      best = stop;
      bestMeters = meters;
    }
  }
  return best;
}

export function matchOriginDestination(
  stops: OrderedStop[],
  originLatitude: number,
  originLongitude: number,
  destinationLatitude: number,
  destinationLongitude: number,
  radiusMeters = MATCH_RADIUS_METERS,
): { origin: OrderedStop; destination: OrderedStop } | null {
  const origin = nearestStop(stops, originLatitude, originLongitude, radiusMeters);
  const destination = nearestStop(
    stops,
    destinationLatitude,
    destinationLongitude,
    radiusMeters,
  );
  if (!origin || !destination || destination.order <= origin.order) {
    return null;
  }
  return { origin, destination };
}
