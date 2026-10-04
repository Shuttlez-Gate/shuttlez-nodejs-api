import { riderHistoryBucket } from './rider-history-bucket';

const now = new Date('2026-10-04T12:00:00.000Z');

function bucket(tripStatus: number, scheduledAt: string, bookingStatus = 2) {
  return riderHistoryBucket({
    bookingStatus,
    tripStatus,
    scheduledAt: new Date(scheduledAt),
    now,
  });
}

describe('rider history buckets', () => {
  it('keeps yesterday, earlier today, completed, and cancelled out of current', () => {
    expect(bucket(3, '2026-10-03T08:00:00.000Z')).toBe('past');
    expect(bucket(1, '2026-10-04T06:00:00.000Z')).toBe('past');
    expect(bucket(2, '2026-10-04T16:00:00.000Z')).toBe('upcoming');
    expect(bucket(3, '2026-10-04T08:00:00.000Z')).toBe('current');
    expect(bucket(4, '2026-10-05T08:00:00.000Z')).toBe('past');
    expect(bucket(1, '2026-10-05T08:00:00.000Z', 3)).toBe('past');
    expect(bucket(2, '2026-10-03T08:00:00.000Z')).toBe('past');
  });
});
