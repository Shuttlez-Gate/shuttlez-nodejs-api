import { groupHistoryBucket, rideHistoryBucket, riderHistoryBucket } from './rider-history-bucket';

/** Wallet default in entity-defaults.ts. History fares use this currency. */
export const TRIP_HISTORY_CURRENCY = 'EGP';

export type TripHistorySourceType = 'trip' | 'ride' | 'group';

export type TripHistoryReadRow = {
  sourceType: TripHistorySourceType;
  sourceId: string;
  departureAt: Date;
  status: number;
  startedAt: Date | null;
  createdAt: Date;
  scheduledFor: Date | null;
  isDeleted: boolean;
  currency: string;
};

export type TripHistoryAudience =
  | { sourceType: 'trip'; sourceId: string; bookingUserIds: string[] }
  | { sourceType: 'ride'; sourceId: string; riderUserId: string }
  | { sourceType: 'group'; sourceId: string; memberUserIds: string[] };

const keyOf = (sourceType: string, sourceId: string) => `${sourceType}:${sourceId}`;

/** In-memory stand-in for the ON CONFLICT upsert. One row per source. */
export class TripHistoryReadStore {
  private readonly rows = new Map<string, TripHistoryReadRow>();

  upsert(row: TripHistoryReadRow): void {
    this.rows.set(keyOf(row.sourceType, row.sourceId), { ...row, currency: TRIP_HISTORY_CURRENCY });
  }

  get(sourceType: TripHistorySourceType, sourceId: string): TripHistoryReadRow | undefined {
    return this.rows.get(keyOf(sourceType, sourceId));
  }

  get size(): number {
    return this.rows.size;
  }

  values(): TripHistoryReadRow[] {
    return [...this.rows.values()];
  }
}

export function passengerCanSeeHistory(userId: string, audience: TripHistoryAudience): boolean {
  if (audience.sourceType === 'trip') return audience.bookingUserIds.includes(userId);
  if (audience.sourceType === 'ride') return audience.riderUserId === userId;
  return audience.memberUserIds.includes(userId);
}

export function historyBucketFor(
  row: TripHistoryReadRow,
  bookingStatus: number | null,
  now: Date,
): 'current' | 'upcoming' | 'past' | null {
  if (row.isDeleted) return null;
  if (row.sourceType === 'trip') {
    if (bookingStatus == null) return null;
    return riderHistoryBucket({
      bookingStatus,
      tripStatus: row.status,
      scheduledAt: row.departureAt,
      now,
    });
  }
  if (row.sourceType === 'ride') {
    return rideHistoryBucket({
      status: row.status,
      scheduledFor: row.scheduledFor,
      startedAt: row.startedAt,
      createdAt: row.createdAt,
      now,
    });
  }
  return groupHistoryBucket({
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
    now,
  });
}

export function pageVisibleHistory(input: {
  rows: TripHistoryReadRow[];
  audiences: TripHistoryAudience[];
  userId: string;
  bucket: 'upcoming' | 'past';
  bookingStatusByTripId?: Record<string, number>;
  page: number;
  pageSize: number;
  now?: Date;
}): { items: TripHistoryReadRow[]; hasNextPage: boolean; hasAny: boolean } {
  const now = input.now ?? new Date();
  const visible = input.rows.filter((row) => {
    const audience = input.audiences.find(
      (item) => item.sourceType === row.sourceType && item.sourceId === row.sourceId,
    );
    return audience != null && passengerCanSeeHistory(input.userId, audience);
  });
  const hasAny = visible.length > 0;
  const bucketRows = visible.filter((row) => {
    const bookingStatus =
      row.sourceType === 'trip' ? (input.bookingStatusByTripId?.[row.sourceId] ?? null) : null;
    return historyBucketFor(row, bookingStatus, now) === input.bucket;
  });
  bucketRows.sort((a, b) => b.departureAt.getTime() - a.departureAt.getTime() || b.sourceId.localeCompare(a.sourceId));
  const start = Math.max(0, (input.page - 1) * input.pageSize);
  const slice = bucketRows.slice(start, start + input.pageSize + 1);
  const hasNextPage = slice.length > input.pageSize;
  return {
    items: hasNextPage ? slice.slice(0, input.pageSize) : slice,
    hasNextPage,
    hasAny,
  };
}
