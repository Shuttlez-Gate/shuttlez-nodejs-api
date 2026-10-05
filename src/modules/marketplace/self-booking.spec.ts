import {
  captainOwnsRoute,
  captainRoutesNotOwnedBy,
  isSelfOwnedTrip,
  riderMaySaveTrip,
  tripsNotOwnedByViewer,
} from './self-booking';

const captain = 'user-captain';
const other = 'user-rider';

describe('self booking rule', () => {
  it('excludes the captain own route from rider search before pagination', () => {
    const where = {
      isDeleted: false,
      publishStatus: 1,
      ...captainRoutesNotOwnedBy(captain),
    };
    expect(where.NOT).toEqual({ ownerDriver: { userId: captain } });
    expect(where).not.toHaveProperty('skip');
  });

  it('rejects a direct booking when the viewer owns or drives the trip', () => {
    expect(isSelfOwnedTrip(captain, captain, other)).toBe(true);
    expect(isSelfOwnedTrip(captain, other, captain)).toBe(true);
  });

  it('rejects saving the viewer own trip as a rider option', () => {
    expect(riderMaySaveTrip(captain, captain, null)).toBe(false);
    expect(riderMaySaveTrip(captain, null, captain)).toBe(false);
  });

  it('still shows the route to another rider', () => {
    expect(isSelfOwnedTrip(other, captain, captain)).toBe(false);
    expect(riderMaySaveTrip(other, captain, captain)).toBe(true);
    expect(captainRoutesNotOwnedBy(other).NOT).toEqual({
      ownerDriver: { userId: other },
    });
  });

  it('keeps the captain management query on their own routes', () => {
    expect(captainOwnsRoute('driver-1')).toEqual({ ownerDriverId: 'driver-1' });
    expect(captainOwnsRoute('driver-1')).not.toHaveProperty('NOT');
  });

  it('excludes every instance of a recurring route through the route owner', () => {
    const filter = tripsNotOwnedByViewer(captain);
    expect(filter.NOT.OR).toEqual([
      { driver: { userId: captain } },
      { route: { ownerDriver: { userId: captain } } },
    ]);
  });
});
