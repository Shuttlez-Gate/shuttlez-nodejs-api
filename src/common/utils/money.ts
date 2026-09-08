import { Prisma } from '@prisma/client';
import { AppException } from '../exceptions/app.exception';
import { ErrorCodes } from '../error-codes';

export function money(
  value:
    | Prisma.Decimal
    | number
    | bigint
    | { toNumber(): number }
    | null
    | undefined,
): number {
  if (value == null) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'object' && 'toNumber' in value) {
    return value.toNumber();
  }
  return Number(value);
}

export function normalizeMoney(value: number): number {
  return Math.round(value * 100 + Number.EPSILON) / 100;
}

export function calculateTotal(pricePerSeat: number, seatCount: number): number {
  if (seatCount <= 0) {
    throw new AppException('عدد المقاعد غير صالح', 400, ErrorCodes.InvalidSeatCount);
  }
  if (pricePerSeat < 0) {
    throw new AppException('السعر غير صالح', 400, ErrorCodes.PricingNotAvailable);
  }
  return normalizeMoney(pricePerSeat * seatCount);
}

export function splitEarnings(
  totalAmount: number,
  platformCommissionPercent: number,
): { commissionRate: number; commissionAmount: number; captainEarnings: number } {
  const clamped = Math.min(100, Math.max(0, platformCommissionPercent));
  const commissionRate = normalizeMoney(clamped / 100);
  const commissionAmount = normalizeMoney(totalAmount * commissionRate);
  const captainEarnings = normalizeMoney(totalAmount - commissionAmount);
  return { commissionRate, commissionAmount, captainEarnings };
}

export function distanceFare(
  baseFare: number,
  distanceKm: number,
  pricePerKm: number,
  minimumFare?: number | null,
  maximumFare?: number | null,
): number {
  let fare = baseFare + distanceKm * pricePerKm;
  if (minimumFare != null && fare < minimumFare) {
    fare = minimumFare;
  }
  if (maximumFare != null && fare > maximumFare) {
    fare = maximumFare;
  }
  return normalizeMoney(fare);
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return r * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function requireCash(raw?: string | null): string {
  const value = (raw ?? 'cash').trim().toLowerCase();
  if (['cash', 'نقدا', 'نقدًا', 'نقد'].includes(value)) {
    return 'cash';
  }
  if (['subscription', 'package', 'باقة'].includes(value)) {
    return 'subscription';
  }
  throw new AppException(
    'طريقة الدفع غير مدعومة. الدفع نقدًا للكابتن فقط حالياً.',
    400,
    ErrorCodes.PaymentMethodNotSupported,
  );
}

export function refCode(prefix: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${y}${m}${d}-${n}`;
}
