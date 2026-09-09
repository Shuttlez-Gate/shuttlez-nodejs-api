export class PagedResult<T> {
  readonly items: T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;

  constructor(items: T[], page: number, pageSize: number, totalCount: number) {
    this.items = items;
    this.page = page;
    this.pageSize = pageSize;
    this.totalCount = totalCount;
  }

  get totalPages(): number {
    if (this.pageSize <= 0) {
      return 0;
    }
    return Math.ceil(this.totalCount / this.pageSize);
  }

  get hasPrevious(): boolean {
    return this.page > 1;
  }

  get hasNext(): boolean {
    return this.page < this.totalPages;
  }

  toJSON() {
    return {
      items: this.items,
      page: this.page,
      pageSize: this.pageSize,
      totalCount: this.totalCount,
      totalPages: this.totalPages,
      hasPrevious: this.hasPrevious,
      hasNext: this.hasNext,
    };
  }

  static empty<T>(page: number, pageSize: number): PagedResult<T> {
    return new PagedResult<T>([], page, pageSize, 0);
  }
}

export interface PageRequest {
  page: number;
  pageSize: number;
  skip: number;
}

export const MAX_PAGE_SIZE = 200;

export function pageRequestFrom(page?: number, pageSize?: number): PageRequest {
  const rawPage = Number(page);
  const rawSize = Number(pageSize);
  const safePage = !Number.isFinite(rawPage) || rawPage < 1 ? 1 : Math.floor(rawPage);
  const safeSize =
    !Number.isFinite(rawSize) || rawSize < 1
      ? 20
      : Math.min(Math.floor(rawSize), MAX_PAGE_SIZE);
  return {
    page: safePage,
    pageSize: safeSize,
    skip: (safePage - 1) * safeSize,
  };
}
