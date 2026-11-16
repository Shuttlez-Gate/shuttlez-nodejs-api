import {
  parseBroadcastCaptainLocation,
  parseConfirmArrival,
  parseJoinRide,
  parseLeaveRide,
  parseRequestTermination,
  parseResolveTermination,
} from './socket-payload';

describe('socket payload parsing', () => {
  it('reads JoinRide from a string, an object, or a one-element array', () => {
    expect(parseJoinRide(' ride-1 ')).toEqual({ rideId: 'ride-1', userId: '' });
    expect(parseJoinRide({ rideId: ' ride-2 ', userId: ' user-2 ' })).toEqual({
      rideId: 'ride-2',
      userId: 'user-2',
    });
    expect(parseJoinRide([{ rideId: 42, userId: 7 }])).toEqual({
      rideId: '42',
      userId: '7',
    });
  });

  it('keeps a non-scalar JoinRide user claim from being ignored', () => {
    expect(parseJoinRide({ rideId: 'ride-1', userId: { id: 'other' } }).userId).toBe(
      '__invalid_user_claim__',
    );
    expect(parseJoinRide({ rideId: 'ride-1' }).userId).toBe('');
  });

  it('reads LeaveRide and ConfirmArrival ids without treating a bare number as an id', () => {
    expect(parseLeaveRide([' ride-9 '])).toEqual({ rideId: 'ride-9' });
    expect(parseLeaveRide(9)).toEqual({ rideId: '' });
    expect(parseConfirmArrival({ rideId: ' ride-3 ' })).toEqual({ rideId: 'ride-3' });
    expect(parseConfirmArrival(null)).toEqual({ rideId: '' });
  });

  it('reads captain location numbers and numeric strings', () => {
    const now = () => '2026-11-16T00:00:00.000Z';
    expect(
      parseBroadcastCaptainLocation(
        [
          {
            rideId: ' ride-4 ',
            latitude: '30.5',
            longitude: 31,
            heading: 0,
            speed: '',
            timestamp: '',
          },
        ],
        now,
      ),
    ).toEqual({
      rideId: 'ride-4',
      latitude: 30.5,
      longitude: 31,
      heading: 0,
      timestamp: '2026-11-16T00:00:00.000Z',
    });
  });

  it('rejects a captain location that has no finite coordinates', () => {
    expect(parseBroadcastCaptainLocation({ rideId: 'ride-4', latitude: 'north' })).toBeNull();
    expect(parseBroadcastCaptainLocation('ride-4')).toBeNull();
  });

  it('reads termination requests and resolutions with the existing field rules', () => {
    expect(
      parseRequestTermination([
        {
          rideId: 'ride-5',
          initiator: 'driver',
          latitude: '29.1',
          longitude: null,
        },
      ]),
    ).toEqual({
      rideId: 'ride-5',
      reason: 'ظرف طارئ',
      initiator: 'driver',
      latitude: 29.1,
    });
    expect(parseRequestTermination({ rideId: 'ride-6', reason: '', initiator: 'rider' })).toEqual({
      rideId: 'ride-6',
      reason: '',
      initiator: 'rider',
    });
    expect(parseResolveTermination({ rideId: 'ride-7', accept: true })).toEqual({
      rideId: 'ride-7',
      accept: true,
    });
    expect(parseResolveTermination({ rideId: 'ride-7', accept: 'true' })).toEqual({
      rideId: 'ride-7',
      accept: false,
    });
  });
});
