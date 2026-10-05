import { remainingForRange, type OrderedStop, type SegmentSeatRow } from './segment-occupancy';
import { isSelfOwnedTrip } from './self-booking';
import { matchRouteToJourney } from './route-match';

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
