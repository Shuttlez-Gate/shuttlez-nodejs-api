/** Shared trip-history paging. Default 10, hard cap 50. Newest first, then id. */

export const HISTORY_PAGE_SIZE = 10;
export const HISTORY_MAX_PAGE_SIZE = 50;

export type HistoryPageRequest = {
  page: number;
  pageSize: number;
  skip: number;
};

export function historyPageRequest(page?: number, pageSize?: number): HistoryPageRequest {
  const rawPage = Number(page);
  const rawSize = Number(pageSize);
  const safePage = !Number.isFinite(rawPage) || rawPage < 1 ? 1 : Math.floor(rawPage);
  const safeSize =
    !Number.isFinite(rawSize) || rawSize < 1
      ? HISTORY_PAGE_SIZE
      : Math.min(Math.floor(rawSize), HISTORY_MAX_PAGE_SIZE);
  return {
    page: safePage,
    pageSize: safeSize,
    skip: (safePage - 1) * safeSize,
  };
}

export type HistorySortRow = {
  id: string;
  sortAt: number;
};

/** In-memory twin of the SQL ORDER BY sort_at DESC, id DESC window. */
export function paginateStable<T extends HistorySortRow>(
  rows: T[],
  page?: number,
  pageSize?: number,
): {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasNextPage: boolean;
} {
  const paging = historyPageRequest(page, pageSize);
  const sorted = [...rows].sort((a, b) => {
    if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  });
  const items = sorted.slice(paging.skip, paging.skip + paging.pageSize);
  return {
    items,
    page: paging.page,
    pageSize: paging.pageSize,
    totalCount: sorted.length,
    hasNextPage: paging.skip + items.length < sorted.length,
  };
}

export function logHistoryPerf(input: {
  endpoint: string;
  status: number;
  queryMs: number;
  countMs: number;
  queries: number;
  bytes: number;
  items: number;
  totalCount: number;
}): void {
  console.log(
    `[perf] endpoint=${input.endpoint} status=${input.status} queryMs=${input.queryMs} countMs=${input.countMs} queries=${input.queries} bytes=${input.bytes} items=${input.items} total=${input.totalCount}`,
  );
}
