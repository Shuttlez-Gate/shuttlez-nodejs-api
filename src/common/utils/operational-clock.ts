export const DEFAULT_OPERATIONAL_TIMEZONE = 'Africa/Cairo';

export type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type OperationalDayBucket = {
  key: string;
  start: Date;
  end: Date;
};

export type DashboardWindow = {
  timeZone: string;
  days: number;
  todayStart: Date;
  todayEnd: Date;
  currentStart: Date;
  currentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
  currentDays: OperationalDayBucket[];
};

export function resolveOperationalTimeZone(raw?: string | null): string {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_OPERATIONAL_TIMEZONE;
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return DEFAULT_OPERATIONAL_TIMEZONE;
  }
}

export function getZonedParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => {
    const value = parts.find((part) => part.type === type)?.value;
    return Number(value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

export function operationalDayKey(date: Date, timeZone: string): string {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone));
  return new Date(utcGuess - timeZoneOffsetMs(first, timeZone));
}

export function startOfOperationalDay(now: Date, timeZone: string): Date {
  const parts = getZonedParts(now, timeZone);
  return zonedWallTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

export function addOperationalDays(start: Date, days: number, timeZone: string): Date {
  const parts = getZonedParts(start, timeZone);
  const noonUtc = Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0);
  return startOfOperationalDay(new Date(noonUtc), timeZone);
}

export function inHalfOpenRange(value: Date, start: Date, end: Date): boolean {
  const time = value.getTime();
  return time >= start.getTime() && time < end.getTime();
}

export function operationalDayBounds(
  dateKey: string,
  timeZoneInput?: string | null,
): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey.trim());
  if (!match) {
    return null;
  }
  const timeZone = resolveOperationalTimeZone(timeZoneInput);
  const start = zonedWallTimeToUtc(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    0,
    0,
    0,
    timeZone,
  );
  return { start, end: addOperationalDays(start, 1, timeZone) };
}

export function isOperationalDateOnly(raw?: string | null): boolean {
  return !!raw && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
}

function parseInstant(raw: string): Date | undefined {
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? undefined : value;
}

/**
 * Admin date filters: YYYY-MM-DD is an operational calendar day.
 * ISO datetimes stay absolute instants (stored Trip.scheduledAt semantics).
 */
export function parseOperationalDateRange(
  from?: string | null,
  to?: string | null,
  timeZoneInput?: string | null,
): { gte?: Date; lt?: Date; lte?: Date } | undefined {
  const timeZone = resolveOperationalTimeZone(timeZoneInput);
  const fromRaw = from?.trim() || '';
  const toRaw = to?.trim() || '';
  if (!fromRaw && !toRaw) {
    return undefined;
  }

  const range: { gte?: Date; lt?: Date; lte?: Date } = {};
  if (fromRaw) {
    if (isOperationalDateOnly(fromRaw)) {
      const bounds = operationalDayBounds(fromRaw, timeZone);
      if (bounds) range.gte = bounds.start;
    } else {
      const instant = parseInstant(fromRaw);
      if (instant) range.gte = instant;
    }
  }
  if (toRaw) {
    if (isOperationalDateOnly(toRaw)) {
      const bounds = operationalDayBounds(toRaw, timeZone);
      if (bounds) range.lt = bounds.end;
    } else {
      const instant = parseInstant(toRaw);
      if (instant) range.lte = instant;
    }
  }
  return range.gte || range.lt || range.lte ? range : undefined;
}

export function upcomingHoursRange(now: Date, hours: number): { gte: Date; lt: Date } {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 3;
  return {
    gte: now,
    lt: new Date(now.getTime() + safeHours * 3_600_000),
  };
}

export function operationalWeekday(date: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

export function parseClockHm(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function operationalDateKeyFromInput(raw: string, timeZone: string): string | null {
  const trimmed = raw.trim();
  if (isOperationalDateOnly(trimmed)) return trimmed;
  const instant = parseInstant(trimmed);
  if (!instant) return null;
  return operationalDayKey(instant, timeZone);
}

/**
 * Admin trip generate: startDate/endDate are operational calendar days (YYYY-MM-DD).
 * times are wall-clock HH:mm in OPERATIONAL_TIMEZONE.
 * daysOfWeek uses JS weekday numbers in that timezone (0=Sunday).
 * Returns absolute instants for Trip.scheduledAt.
 */
export function enumerateOperationalSchedule(opts: {
  startDate: string;
  endDate: string;
  times: string[];
  daysOfWeek?: number[];
  timeZone?: string | null;
}): Date[] {
  const timeZone = resolveOperationalTimeZone(opts.timeZone);
  const startKey = operationalDateKeyFromInput(opts.startDate || '', timeZone);
  const endKey = operationalDateKeyFromInput(opts.endDate || '', timeZone);
  if (!startKey || !endKey) return [];
  const startBounds = operationalDayBounds(startKey, timeZone);
  const endBounds = operationalDayBounds(endKey, timeZone);
  if (!startBounds || !endBounds || startBounds.start.getTime() > endBounds.start.getTime()) {
    return [];
  }
  const clocks = (opts.times ?? [])
    .map((item) => parseClockHm(item))
    .filter((item): item is { hour: number; minute: number } => item != null);
  if (!clocks.length) return [];

  const instants: Date[] = [];
  let dayStart = startBounds.start;
  while (dayStart.getTime() <= endBounds.start.getTime()) {
    const weekday = operationalWeekday(dayStart, timeZone);
    if (!opts.daysOfWeek?.length || opts.daysOfWeek.includes(weekday)) {
      const parts = getZonedParts(dayStart, timeZone);
      for (const clock of clocks) {
        instants.push(
          zonedWallTimeToUtc(
            parts.year,
            parts.month,
            parts.day,
            clock.hour,
            clock.minute,
            0,
            timeZone,
          ),
        );
      }
    }
    dayStart = addOperationalDays(dayStart, 1, timeZone);
  }
  return instants;
}

/** Absolute instants. Half-open [gte, lt) to match dashboard.operations.tripsSoon. */
export function parseAbsoluteInstantRange(
  from?: string | null,
  to?: string | null,
): { gte?: Date; lt?: Date } | undefined {
  const fromRaw = from?.trim() || '';
  const toRaw = to?.trim() || '';
  if (!fromRaw && !toRaw) {
    return undefined;
  }
  const range: { gte?: Date; lt?: Date } = {};
  if (fromRaw) {
    const instant = parseInstant(fromRaw);
    if (instant) range.gte = instant;
  }
  if (toRaw) {
    const instant = parseInstant(toRaw);
    if (instant) range.lt = instant;
  }
  return range.gte || range.lt ? range : undefined;
}

export const TRIPS_SOON_STATUS_QUERY = 'scheduled,driverAssigned';

export function tripsSoonListQuery(from: Date, to: Date) {
  return {
    fromDateTime: from.toISOString(),
    toDateTime: to.toISOString(),
    status: TRIPS_SOON_STATUS_QUERY,
  };
}

export function getDashboardWindow(
  now: Date,
  daysInput: number,
  timeZoneInput?: string | null,
): DashboardWindow {
  const days = Math.min(180, Math.max(7, Number(daysInput) || 30));
  const timeZone = resolveOperationalTimeZone(timeZoneInput);
  const todayStart = startOfOperationalDay(now, timeZone);
  const todayEnd = addOperationalDays(todayStart, 1, timeZone);
  const currentStart = addOperationalDays(todayStart, -(days - 1), timeZone);
  const currentEnd = todayEnd;
  const previousEnd = currentStart;
  const previousStart = addOperationalDays(currentStart, -days, timeZone);
  const currentDays: OperationalDayBucket[] = Array.from({ length: days }, (_, offset) => {
    const start = addOperationalDays(currentStart, offset, timeZone);
    const end = addOperationalDays(start, 1, timeZone);
    return { key: operationalDayKey(start, timeZone), start, end };
  });
  return {
    timeZone,
    days,
    todayStart,
    todayEnd,
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
    currentDays,
  };
}
