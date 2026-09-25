export const ROUTE_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'converted',
] as const;

export type RouteRequestStatus = (typeof ROUTE_REQUEST_STATUSES)[number];

export function normalizeRouteRequestStatus(raw?: string | null): string {
  return (raw || '').trim().toLowerCase();
}

/** Allowed Admin transitions. Approval does not create an official Route. */
export function canTransitionRouteRequest(from: string, to: string): boolean {
  const current = normalizeRouteRequestStatus(from);
  const next = normalizeRouteRequestStatus(to);
  if (!next || !ROUTE_REQUEST_STATUSES.includes(next as RouteRequestStatus)) {
    return false;
  }
  if (current === next) return true;
  if (current === 'pending' && (next === 'approved' || next === 'rejected')) return true;
  if (current === 'approved' && next === 'converted') return true;
  return false;
}
