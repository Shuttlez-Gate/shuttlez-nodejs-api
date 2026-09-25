import {
  canTransitionRouteRequest,
  normalizeRouteRequestStatus,
} from './route-request-workflow';

describe('route request workflow', () => {
  it('allows Pending → Approved and Pending → Rejected', () => {
    expect(canTransitionRouteRequest('pending', 'approved')).toBe(true);
    expect(canTransitionRouteRequest('Pending', 'Rejected')).toBe(true);
    expect(normalizeRouteRequestStatus(' Approved ')).toBe('approved');
  });

  it('does not change state when the transition is rejected', () => {
    const current = 'pending';
    expect(canTransitionRouteRequest(current, 'converted')).toBe(false);
    expect(canTransitionRouteRequest('rejected', 'approved')).toBe(false);
    expect(current).toBe('pending');
  });

  it('allows Approved → Converted and same-status idempotent updates', () => {
    expect(canTransitionRouteRequest('approved', 'converted')).toBe(true);
    expect(canTransitionRouteRequest('approved', 'approved')).toBe(true);
  });
});
