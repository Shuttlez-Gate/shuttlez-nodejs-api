/**
 * Normalizes Egyptian phone numbers to E.164: +201xxxxxxxxx
 */
export function normalizePhone(phone: string): string {
  const digits = [...phone].filter((ch) => ch >= '0' && ch <= '9').join('');

  if (digits.startsWith('20') && digits.length === 12) {
    return `+${digits}`;
  }

  if (digits.startsWith('0') && digits.length === 11) {
    return `+20${digits.slice(1)}`;
  }

  if (digits.length === 10 && digits.startsWith('1')) {
    return `+20${digits}`;
  }

  const trimmed = phone.trim();
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}
