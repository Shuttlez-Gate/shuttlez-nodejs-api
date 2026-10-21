import { readFileSync } from 'fs';
import { join } from 'path';
import { BookingStatus, GroupRequestStatus, RideRequestStatus, TripStatus } from '../../common/enums';
import { groupHistoryBucket, rideHistoryBucket } from './rider-history-bucket';
import {
  TRIP_HISTORY_CURRENCY,
  TripHistoryReadStore,
  pageVisibleHistory,
  passengerCanSeeHistory,
  type TripHistoryReadRow,
} from './trip-history-read-model';

const now = new Date('2026-10-11T12:00:00.000Z');

function row(partial: Partial<TripHistoryReadRow> & Pick<TripHistoryReadRow, 'sourceType' | 'sourceId'>): TripHistoryReadRow {
  return {
    departureAt: new Date('2026-10-12T08:00:00.000Z'),
    status: TripStatus.Scheduled,
    startedAt: null,
    createdAt: now,
    scheduledFor: null,
    isDeleted: false,
    currency: TRIP_HISTORY_CURRENCY,
    ...partial,
  };
}

describe('trip history read model', () => {
  const sql = readFileSync(
    join(__dirname, '../../../prisma/sql/20261011_trip_history_read_model.sql'),
    'utf8',
  );

  it('stores one row per source and repeats the upsert in place', () => {
    const store = new TripHistoryReadStore();
    const group = row({
      sourceType: 'group',
      sourceId: 'group-1',
      status: GroupRequestStatus.Confirmed,
    });
    store.upsert(group);
    store.upsert({ ...group, status: GroupRequestStatus.Cancelled });
    expect(store.size).toBe(1);
    expect(store.get('group', 'group-1')?.status).toBe(GroupRequestStatus.Cancelled);
    expect(store.get('group', 'group-1')?.currency).toBe('EGP');
  });

  it('lets only booked passengers, the rider, and group members see a trip', () => {
    expect(
      passengerCanSeeHistory('a', {
        sourceType: 'trip',
        sourceId: 't1',
        bookingUserIds: ['a', 'b'],
      }),
    ).toBe(true);
    expect(
      passengerCanSeeHistory('stranger', {
        sourceType: 'trip',
        sourceId: 't1',
        bookingUserIds: ['a', 'b'],
      }),
    ).toBe(false);
    expect(
      passengerCanSeeHistory('rider', {
        sourceType: 'ride',
        sourceId: 'r1',
        riderUserId: 'rider',
      }),
    ).toBe(true);
    expect(
      passengerCanSeeHistory('other', {
        sourceType: 'ride',
        sourceId: 'r1',
        riderUserId: 'rider',
      }),
    ).toBe(false);
    expect(
      passengerCanSeeHistory('member', {
        sourceType: 'group',
        sourceId: 'g1',
        memberUserIds: ['organizer', 'member'],
      }),
    ).toBe(true);
    expect(
      passengerCanSeeHistory('stranger', {
        sourceType: 'group',
        sourceId: 'g1',
        memberUserIds: ['organizer', 'member'],
      }),
    ).toBe(false);
  });

  it('paginates upcoming rows for one passenger and hides unrelated trips', () => {
    const rows = [
      row({ sourceType: 'trip', sourceId: 'mine', departureAt: new Date('2026-10-12T09:00:00.000Z') }),
      row({ sourceType: 'trip', sourceId: 'theirs', departureAt: new Date('2026-10-13T09:00:00.000Z') }),
      row({
        sourceType: 'ride',
        sourceId: 'ride-1',
        status: RideRequestStatus.Requested,
        scheduledFor: null,
        createdAt: now,
        departureAt: now,
      }),
      row({
        sourceType: 'group',
        sourceId: 'group-1',
        status: GroupRequestStatus.Confirmed,
        createdAt: now,
        departureAt: now,
      }),
    ];
    const audiences = [
      { sourceType: 'trip' as const, sourceId: 'mine', bookingUserIds: ['me'] },
      { sourceType: 'trip' as const, sourceId: 'theirs', bookingUserIds: ['other'] },
      { sourceType: 'ride' as const, sourceId: 'ride-1', riderUserId: 'me' },
      { sourceType: 'group' as const, sourceId: 'group-1', memberUserIds: ['me', 'friend'] },
    ];
    const page = pageVisibleHistory({
      rows,
      audiences,
      userId: 'me',
      bucket: 'upcoming',
      bookingStatusByTripId: { mine: BookingStatus.Confirmed },
      page: 1,
      pageSize: 20,
      now,
    });
    expect(page.items.map((item) => item.sourceId).sort()).toEqual(['group-1', 'mine', 'ride-1']);
    expect(page.hasAny).toBe(true);
    expect(page.hasNextPage).toBe(false);

    const stranger = pageVisibleHistory({
      rows,
      audiences,
      userId: 'stranger',
      bucket: 'upcoming',
      bookingStatusByTripId: {},
      page: 1,
      pageSize: 20,
      now,
    });
    expect(stranger.items).toEqual([]);
    expect(stranger.hasAny).toBe(false);
  });

  it('moves a rescheduled, cancelled, or completed shuttle into the right bucket', () => {
    const store = new TripHistoryReadStore();
    const base = row({ sourceType: 'trip', sourceId: 't1' });
    store.upsert(base);
    store.upsert({ ...base, departureAt: new Date('2026-10-20T09:00:00.000Z') });
    expect(store.size).toBe(1);
    const audiences = [{ sourceType: 'trip' as const, sourceId: 't1', bookingUserIds: ['me'] }];
    const upcoming = pageVisibleHistory({
      rows: store.values(),
      audiences,
      userId: 'me',
      bucket: 'upcoming',
      bookingStatusByTripId: { t1: BookingStatus.Confirmed },
      page: 1,
      pageSize: 20,
      now,
    });
    expect(upcoming.items).toHaveLength(1);

    store.upsert({ ...store.get('trip', 't1')!, status: TripStatus.Cancelled });
    const past = pageVisibleHistory({
      rows: store.values(),
      audiences,
      userId: 'me',
      bucket: 'past',
      bookingStatusByTripId: { t1: BookingStatus.Confirmed },
      page: 1,
      pageSize: 20,
      now,
    });
    expect(past.items.map((item) => item.sourceId)).toEqual(['t1']);

    store.upsert({ ...store.get('trip', 't1')!, status: TripStatus.Completed });
    const completed = pageVisibleHistory({
      rows: store.values(),
      audiences,
      userId: 'me',
      bucket: 'past',
      bookingStatusByTripId: { t1: BookingStatus.Confirmed },
      page: 1,
      pageSize: 20,
      now,
    });
    expect(completed.items).toHaveLength(1);
  });

  it('returns the next page without the first page of rows', () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      row({
        sourceType: 'ride',
        sourceId: `ride-${String(index).padStart(2, '0')}`,
        status: RideRequestStatus.Requested,
        createdAt: now,
        departureAt: new Date(now.getTime() + index * 1000),
      }),
    );
    const audiences = rows.map((item) => ({
      sourceType: 'ride' as const,
      sourceId: item.sourceId,
      riderUserId: 'me',
    }));
    const first = pageVisibleHistory({
      rows,
      audiences,
      userId: 'me',
      bucket: 'upcoming',
      page: 1,
      pageSize: 20,
      now,
    });
    const second = pageVisibleHistory({
      rows,
      audiences,
      userId: 'me',
      bucket: 'upcoming',
      page: 2,
      pageSize: 20,
      now,
    });
    expect(first.items).toHaveLength(20);
    expect(first.hasNextPage).toBe(true);
    expect(second.items).toHaveLength(5);
    expect(second.hasNextPage).toBe(false);
    expect(second.items.some((item) => first.items.includes(item))).toBe(false);
  });

  it('classifies an in-progress ride today as current and a completed ride as past', () => {
    expect(
      rideHistoryBucket({
        status: RideRequestStatus.InProgress,
        scheduledFor: null,
        startedAt: now,
        createdAt: now,
        now,
      }),
    ).toBe('current');
    expect(
      rideHistoryBucket({
        status: RideRequestStatus.Completed,
        scheduledFor: null,
        startedAt: now,
        createdAt: now,
        now,
      }),
    ).toBe('past');
    expect(
      groupHistoryBucket({
        status: GroupRequestStatus.InProgress,
        startedAt: now,
        createdAt: now,
        now,
      }),
    ).toBe('current');
    expect(
      groupHistoryBucket({
        status: GroupRequestStatus.Completed,
        startedAt: now,
        createdAt: now,
        now,
      }),
    ).toBe('past');
  });

  it('keeps the database upsert unique per source and out of the passenger tables', () => {
    expect(sql).toContain('ON CONFLICT ("SourceType", "SourceId")');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "UX_TripHistoryReadModel_Source"');
    expect(sql).toContain('FROM "GroupRequestsSet" g');
    const table = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf('CREATE UNIQUE INDEX'));
    expect(table).not.toContain('"UserId"');
  });
});
