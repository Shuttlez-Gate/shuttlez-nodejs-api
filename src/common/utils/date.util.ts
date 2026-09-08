export function newId(): string {
  return crypto.randomUUID();
}

export function utcNow(): Date {
  return new Date();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}
