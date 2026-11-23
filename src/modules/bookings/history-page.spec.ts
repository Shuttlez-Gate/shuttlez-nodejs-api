import { readFileSync } from 'fs';
import { join } from 'path';
import { historyPageRequest, paginateStable } from './history-page';

describe('trip history pagination', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `trip-${String(index).padStart(2, '0')}`,
    sortAt: index,
    owner: index % 2 === 0 ? 'me' : 'other',
  }));

  it('defaults to 10 and caps the page size at 50', () => {
    expect(historyPageRequest(undefined, undefined)).toMatchObject({
      page: 1,
      pageSize: 10,
      skip: 0,
    });
    expect(historyPageRequest(0, 0).pageSize).toBe(10);
    expect(historyPageRequest(2, 80)).toMatchObject({ page: 2, pageSize: 50, skip: 50 });
  });

  it('returns a stable newest-first page with an exact total and no overlap', () => {
    const mine = rows.filter((row) => row.owner === 'me');
    const first = paginateStable(mine, 1, 10);
    const second = paginateStable(mine, 2, 10);
    expect(first.totalCount).toBe(mine.length);
    expect(first.items).toHaveLength(10);
    expect(first.hasNextPage).toBe(true);
    expect(first.items[0].sortAt).toBeGreaterThan(first.items[1].sortAt);
    expect(second.hasNextPage).toBe(second.items.length === 10 && 20 < mine.length);
    const seen = new Set(first.items.map((item) => item.id));
    expect(second.items.some((item) => seen.has(item.id))).toBe(false);
  });

  it('does not include another user rows', () => {
    const mine = paginateStable(
      rows.filter((row) => row.owner === 'me'),
      1,
      10,
    );
    expect(mine.items.every((item) => item.owner === 'me')).toBe(true);
    expect(mine.totalCount).toBe(13);
  });

  it('reads shuttle trips from the booking, not only the read model', () => {
    const sql = readFileSync(join(__dirname, 'rider-history-page.ts'), 'utf8');
    expect(sql).toContain('INNER JOIN "TripsSet" t');
    expect(sql).toContain('INNER JOIN "GroupRequestsSet" g');
    expect(sql).not.toContain('INNER JOIN "TripHistoryReadModel"');
    expect(sql).toContain('totalCount');
  });

  it('stops on the last partial page', () => {
    const page = paginateStable(rows, 3, 10);
    expect(page.items).toHaveLength(5);
    expect(page.totalCount).toBe(25);
    expect(page.hasNextPage).toBe(false);
  });
});
