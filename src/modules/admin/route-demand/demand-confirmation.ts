/** Landing/website signals are never confirmed passengers. */
export function isConfirmedDemandPassenger(
  source: string,
  requestStatus?: string | null,
): boolean {
  if (source !== 'app') {
    return false;
  }
  const status = (requestStatus || '').toLowerCase();
  return status === 'approved' || status === 'converted';
}
