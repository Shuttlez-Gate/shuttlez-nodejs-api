import {
  CAPTAIN_ROUTE_SEARCH_RADIUS_METERS,
  remainingForRange,
  type OrderedStop,
  type SegmentSeatRow,
} from './segment-occupancy';
import { isSelfOwnedTrip } from './self-booking';
import { matchPreviewStops, matchRouteToJourney } from './route-match';

const mataria: OrderedStop = {
  id: 'mataria',
  order: 0,
  name: 'المطرية',
  latitude: 30.121,
  longitude: 31.288,
};
const nasr: OrderedStop = {
  id: 'nasr',
  order: 1,
  name: 'أول عباس / مدينة نصر',
  latitude: 30.062,
  longitude: 31.33,
};
const captainStops = [mataria, nasr];

describe('captain route matching', () => {
  it('does not return Mataria → Nasr City for Helwan → El Shorouk', () => {
    const byCoords = matchRouteToJourney(captainStops, {
      fromLatitude: 29.849,
      fromLongitude: 31.334,
      toLatitude: 30.145,
      toLongitude: 31.616,
      fromAddress: 'Helwan',
      toAddress: 'El Shorouk',
    });
    const byName = matchRouteToJourney(captainStops, {
      fromAddress: 'حلوان',
      toAddress: 'الشروق',
    });
    expect(byCoords).toBeNull();
    expect(byName).toBeNull();
  });

  it('matches Helwan to Nasr City by name when the pin is outside 600m', () => {
    const stops = [
      { id: 'helwan', order: 1, name: 'حلوان', latitude: 29.85, longitude: 31.335 },
      { id: 'nasr', order: 3, name: 'مدينة نصر', latitude: 30.0511, longitude: 31.3656 },
    ];
    const match = matchPreviewStops(stops, {
      fromLatitude: 29.8419,
      fromLongitude: 31.3003,
      toLatitude: 30.0561,
      toLongitude: 31.33,
      fromAddress: 'حلوان، القاهرة',
      toAddress: 'مدينة نصر، القاهرة',
    });
    expect(match?.origin.id).toBe('helwan');
    expect(match?.destination.id).toBe('nasr');
  });

  it('selects Wesal to Helwan when the pin is on the same station area', () => {
    const stops = [
      {
        id: 'wesal',
        order: 0,
        name: 'مدينة وصال',
        latitude: 30.1174388,
        longitude: 31.5947022,
      },
      {
        id: 'helwan',
        order: 1,
        name: 'حلوان',
        latitude: 29.8421513,
        longitude: 31.3333537,
      },
    ];
    const match = matchPreviewStops(stops, {
      fromLatitude: 30.1163861,
      fromLongitude: 31.5867233,
      toLatitude: 29.8492,
      toLongitude: 31.3342,
      fromAddress: 'وصال',
      toAddress: 'حلوان',
    });
    expect(match?.origin.id).toBe('wesal');
    expect(match?.destination.id).toBe('helwan');
  });

  it('matches a rider whose origin and destination sit on the route', () => {
    const match = matchRouteToJourney(captainStops, {
      fromLatitude: 30.1212,
      fromLongitude: 31.2881,
      toLatitude: 30.0621,
      toLongitude: 31.3302,
    });
    expect(match?.origin.id).toBe('mataria');
    expect(match?.destination.id).toBe('nasr');
  });

  it('matches both requested endpoints within the 1500m captain search radius', () => {
    const stops: OrderedStop[] = [
      { id: 'pickup', order: 0, name: 'Pickup', latitude: 30, longitude: 31 },
      { id: 'dropoff', order: 1, name: 'Dropoff', latitude: 30.1, longitude: 31.1 },
    ];
    const match = matchRouteToJourney(
      stops,
      {
        fromLatitude: 30.012,
        fromLongitude: 31,
        toLatitude: 30.112,
        toLongitude: 31.1,
      },
      CAPTAIN_ROUTE_SEARCH_RADIUS_METERS,
    );

    expect(match?.origin.id).toBe('pickup');
    expect(match?.destination.id).toBe('dropoff');
  });

  it('rejects the match when either endpoint is outside 1500m', () => {
    const match = matchRouteToJourney(
      [
        { id: 'pickup', order: 0, name: 'Pickup', latitude: 30, longitude: 31 },
        { id: 'dropoff', order: 1, name: 'Dropoff', latitude: 30.1, longitude: 31.1 },
      ],
      {
        fromLatitude: 30.012,
        fromLongitude: 31,
        toLatitude: 30.116,
        toLongitude: 31.1,
      },
      CAPTAIN_ROUTE_SEARCH_RADIUS_METERS,
    );

    expect(match).toBeNull();
  });

  it('requires the destination stop to come after the pickup stop', () => {
    const match = matchRouteToJourney(
      [
        { id: 'pickup', order: 0, name: 'Pickup', latitude: 30, longitude: 31 },
        { id: 'dropoff', order: 1, name: 'Dropoff', latitude: 30.1, longitude: 31.1 },
      ],
      {
        fromLatitude: 30.1,
        fromLongitude: 31.1,
        toLatitude: 30,
        toLongitude: 31,
      },
      CAPTAIN_ROUTE_SEARCH_RADIUS_METERS,
    );

    expect(match).toBeNull();
  });

  it('books only the selected trip instance', () => {
    const capacity = (): SegmentSeatRow[] => [
      { fromOrder: 0, toOrder: 1, remainingSeats: 4 },
    ];
    const inventory = new Map<string, SegmentSeatRow[]>([
      ['2026-10-05', capacity()],
      ['2026-10-06', capacity()],
      ['2026-10-07', capacity()],
      ['2026-10-08', capacity()],
      ['2026-10-09', capacity()],
      ['2026-10-10', capacity()],
    ]);
    const booked = inventory.get('2026-10-07');
    if (!booked) throw new Error('missing Oct 7 instance');
    booked[0] = { ...booked[0], remainingSeats: booked[0].remainingSeats - 1 };
    expect(remainingForRange(inventory.get('2026-10-07') ?? [], 0, 1)).toBe(3);
    for (const day of ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10']) {
      expect(remainingForRange(inventory.get(day) ?? [], 0, 1)).toBe(4);
    }
  });

  it('hides the captain own instance and keeps it for another rider', () => {
    const instance = { ownerUserId: 'captain-user', driverUserId: 'captain-user' };
    const visible = (viewerId: string) =>
      !isSelfOwnedTrip(viewerId, instance.ownerUserId, instance.driverUserId);
    expect(visible('captain-user')).toBe(false);
    expect(visible('other-rider')).toBe(true);
  });
});
