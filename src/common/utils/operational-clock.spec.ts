import { TripStatus } from '../../common/enums';
import { parseTripStatuses } from '../../common/utils/enums-map';
import {
  DEFAULT_OPERATIONAL_TIMEZONE,
  enumerateOperationalSchedule,
  getDashboardWindow,
  inHalfOpenRange,
  operationalDayBounds,
  operationalDayKey,
  operationalWeekday,
  parseAbsoluteInstantRange,
  parseOperationalDateRange,
  resolveOperationalTimeZone,
  tripsSoonListQuery,
  upcomingHoursRange,
} from '../../common/utils/operational-clock';

describe('operational-clock', () => {
  const cairo = DEFAULT_OPERATIONAL_TIMEZONE;

  it('defaults invalid timezone to Africa/Cairo', () => {
    expect(resolveOperationalTimeZone(undefined)).toBe(cairo);
    expect(resolveOperationalTimeZone('Not/AZone')).toBe(cairo);
  });

  it('places 21:30 UTC on the next Cairo operational day in late September', () => {
    const nearUtcMidnight = new Date('2026-09-24T21:30:00.000Z');
    expect(operationalDayKey(nearUtcMidnight, cairo)).toBe('2026-09-25');
  });

  it('keeps 20:30 UTC on the same Cairo operational day in late September', () => {
    const eveningUtc = new Date('2026-09-24T20:30:00.000Z');
    expect(operationalDayKey(eveningUtc, cairo)).toBe('2026-09-24');
  });

  it('builds current and previous windows with the same day count and timezone', () => {
    const now = new Date('2026-09-25T01:15:00.000Z');
    const window = getDashboardWindow(now, 7, cairo);
    expect(window.timeZone).toBe(cairo);
    expect(window.days).toBe(7);
    expect(window.currentDays).toHaveLength(7);
    expect(window.currentEnd.getTime()).toBe(window.todayEnd.getTime());
    expect(window.previousEnd.getTime()).toBe(window.currentStart.getTime());
    expect(operationalDayKey(window.todayStart, cairo)).toBe('2026-09-25');
    expect(inHalfOpenRange(now, window.todayStart, window.todayEnd)).toBe(true);
    expect(inHalfOpenRange(now, window.currentStart, window.currentEnd)).toBe(true);
    expect(inHalfOpenRange(now, window.previousStart, window.previousEnd)).toBe(false);
  });
});

describe('operations period helpers', () => {
  it('uses one half-open range for route performance and revenue', () => {
    const window = getDashboardWindow(new Date('2026-09-25T10:00:00.000Z'), 30, 'Africa/Cairo');
    const bookingInPeriod = new Date(window.currentStart.getTime() + 3_600_000);
    const bookingPrevious = new Date(window.previousStart.getTime() + 3_600_000);
    expect(inHalfOpenRange(bookingInPeriod, window.currentStart, window.currentEnd)).toBe(true);
    expect(inHalfOpenRange(bookingPrevious, window.currentStart, window.currentEnd)).toBe(false);
    expect(inHalfOpenRange(bookingPrevious, window.previousStart, window.previousEnd)).toBe(true);
  });
});

describe('operational date filters', () => {
  const cairo = DEFAULT_OPERATIONAL_TIMEZONE;

  it('interprets 2026-09-25 as Africa/Cairo, not UTC', () => {
    const range = parseOperationalDateRange('2026-09-25', '2026-09-25', cairo);
    const utcDay = new Date('2026-09-25T00:00:00.000Z');
    expect(range?.gte).toBeDefined();
    expect(range?.lt).toBeDefined();
    expect(range!.gte!.toISOString()).not.toBe(utcDay.toISOString());
    expect(operationalDayKey(range!.gte!, cairo)).toBe('2026-09-25');
    expect(operationalDayKey(new Date(range!.lt!.getTime() - 1), cairo)).toBe('2026-09-25');
    expect(operationalDayKey(range!.lt!, cairo)).toBe('2026-09-26');
  });

  it('places a trip just before operational midnight on the previous day', () => {
    const bounds = operationalDayBounds('2026-09-25', cairo)!;
    const before = new Date(bounds.start.getTime() - 1);
    expect(inHalfOpenRange(before, bounds.start, bounds.end)).toBe(false);
    expect(operationalDayKey(before, cairo)).toBe('2026-09-24');
  });

  it('places a trip at operational midnight on that operational date', () => {
    const bounds = operationalDayBounds('2026-09-25', cairo)!;
    expect(inHalfOpenRange(bounds.start, bounds.start, bounds.end)).toBe(true);
    expect(operationalDayKey(bounds.start, cairo)).toBe('2026-09-25');
  });

  it('keeps 23:59:59 inside the day and next-day 00:00 outside [start, end)', () => {
    const bounds = operationalDayBounds('2026-09-25', cairo)!;
    const almostEnd = new Date(bounds.end.getTime() - 1);
    expect(inHalfOpenRange(almostEnd, bounds.start, bounds.end)).toBe(true);
    expect(operationalDayKey(almostEnd, cairo)).toBe('2026-09-25');
    expect(inHalfOpenRange(bounds.end, bounds.start, bounds.end)).toBe(false);
    expect(operationalDayKey(bounds.end, cairo)).toBe('2026-09-26');
  });

  it('keeps UTC midnight of 2026-09-25 inside the Cairo operational day', () => {
    const bounds = operationalDayBounds('2026-09-25', cairo)!;
    const utcMidnight = new Date('2026-09-25T00:00:00.000Z');
    expect(inHalfOpenRange(utcMidnight, bounds.start, bounds.end)).toBe(true);
  });

  it('matches dashboard today with /admin/trips from=to=todayKey', () => {
    const now = new Date('2026-09-25T22:15:00.000Z');
    const window = getDashboardWindow(now, 7, cairo);
    const todayKey = operationalDayKey(window.todayStart, cairo);
    const range = parseOperationalDateRange(todayKey, todayKey, cairo);
    expect(range?.gte?.getTime()).toBe(window.todayStart.getTime());
    expect(range?.lt?.getTime()).toBe(window.todayEnd.getTime());
  });

  it('uses server now for the next 3 hours window', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const range = upcomingHoursRange(now, 3);
    expect(range.lt.getTime() - range.gte.getTime()).toBe(3 * 3_600_000);
    expect(inHalfOpenRange(new Date('2026-09-25T12:59:59.000Z'), range.gte, range.lt)).toBe(
      true,
    );
    expect(inHalfOpenRange(new Date('2026-09-25T13:00:00.000Z'), range.gte, range.lt)).toBe(
      false,
    );
  });

  it('maps the next-3-hours list filter to the same half-open server window', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const window = upcomingHoursRange(now, 3);
    const query = tripsSoonListQuery(window.gte, window.lt);
    const range = parseAbsoluteInstantRange(query.fromDateTime, query.toDateTime);
    expect(range?.gte?.getTime()).toBe(window.gte.getTime());
    expect(range?.lt?.getTime()).toBe(window.lt.getTime());
    expect(parseTripStatuses(query.status)).toEqual([
      TripStatus.Scheduled,
      TripStatus.DriverAssigned,
    ]);
  });

  it('prefers fromDateTime/toDateTime as absolute instants, not operational days', () => {
    const from = '2026-09-25T21:30:00.000Z';
    const to = '2026-09-26T00:30:00.000Z';
    const instant = parseAbsoluteInstantRange(from, to);
    const dayRange = parseOperationalDateRange('2026-09-25', '2026-09-25', cairo);
    expect(instant?.gte?.toISOString()).toBe(from);
    expect(instant?.lt?.toISOString()).toBe(to);
    expect(instant?.gte?.getTime()).not.toBe(dayRange?.gte?.getTime());
    expect(instant?.lt?.getTime()).not.toBe(dayRange?.lt?.getTime());
  });
});

describe('operational trip generate', () => {
  const cairo = DEFAULT_OPERATIONAL_TIMEZONE;

  it('interprets 07:00 on 2026-09-25 as Cairo wall time, not UTC', () => {
    const [instant] = enumerateOperationalSchedule({
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      times: ['07:00'],
      timeZone: cairo,
    });
    expect(instant.toISOString()).toBe('2026-09-25T04:00:00.000Z');
    expect(operationalDayKey(instant, cairo)).toBe('2026-09-25');
  });

  it('places Cairo midnight on that operational day', () => {
    const [instant] = enumerateOperationalSchedule({
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      times: ['00:00'],
      timeZone: cairo,
    });
    const bounds = operationalDayBounds('2026-09-25', cairo)!;
    expect(instant.getTime()).toBe(bounds.start.getTime());
    expect(inHalfOpenRange(instant, bounds.start, bounds.end)).toBe(true);
  });

  it('keeps a 02:00 Cairo slot inside the Cairo day when UTC is still the previous date', () => {
    const [instant] = enumerateOperationalSchedule({
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      times: ['02:00'],
      timeZone: cairo,
    });
    expect(instant.toISOString()).toBe('2026-09-24T23:00:00.000Z');
    expect(operationalDayKey(instant, cairo)).toBe('2026-09-25');
  });

  it('uses operational weekday, not UTC weekday, near midnight', () => {
    const fridayCairo = enumerateOperationalSchedule({
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      times: ['01:00'],
      daysOfWeek: [5],
      timeZone: cairo,
    });
    const thursdayUtc = enumerateOperationalSchedule({
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      times: ['01:00'],
      daysOfWeek: [4],
      timeZone: cairo,
    });
    expect(fridayCairo).toHaveLength(1);
    expect(thursdayUtc).toHaveLength(0);
    expect(operationalWeekday(fridayCairo[0], cairo)).toBe(5);
  });

  it('includes both ends of an operational date range', () => {
    const instants = enumerateOperationalSchedule({
      startDate: '2026-09-24',
      endDate: '2026-09-25',
      times: ['07:00'],
      timeZone: cairo,
    });
    expect(instants).toHaveLength(2);
    expect(operationalDayKey(instants[0], cairo)).toBe('2026-09-24');
    expect(operationalDayKey(instants[1], cairo)).toBe('2026-09-25');
  });

  it('selects Saturday and Sunday by operational weekday, not UTC weekday', () => {
    const saturday = enumerateOperationalSchedule({
      startDate: '2026-09-26',
      endDate: '2026-09-26',
      times: ['01:00'],
      daysOfWeek: [6],
      timeZone: cairo,
    });
    const sunday = enumerateOperationalSchedule({
      startDate: '2026-09-27',
      endDate: '2026-09-27',
      times: ['01:00'],
      daysOfWeek: [0],
      timeZone: cairo,
    });
    expect(saturday).toHaveLength(1);
    expect(sunday).toHaveLength(1);
    expect(saturday[0].toISOString()).toBe('2026-09-25T22:00:00.000Z');
    expect(sunday[0].toISOString()).toBe('2026-09-26T22:00:00.000Z');
    expect(saturday[0].getUTCDay()).toBe(5);
    expect(sunday[0].getUTCDay()).toBe(6);
    expect(operationalWeekday(saturday[0], cairo)).toBe(6);
    expect(operationalWeekday(sunday[0], cairo)).toBe(0);
  });

  it('produces an absolute instant whose UTC clock differs from Cairo wall-clock', () => {
    const [instant] = enumerateOperationalSchedule({
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      times: ['19:30'],
      timeZone: cairo,
    });
    expect(instant.toISOString()).toBe('2026-09-25T16:30:00.000Z');
    expect(instant.toISOString().includes('T19:30')).toBe(false);
  });
});
