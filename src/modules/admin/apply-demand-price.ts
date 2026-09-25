/** Apply-demand / trip create must receive an explicit seat price. Never invent a default. */
export function resolveApplyDemandPrice(raw?: number | null): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

export function resolveRequiredAvailableSeats(raw?: number | null): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return null;
  }
  return Math.trunc(value);
}
