export interface JoinRideMessage {
  rideId: string;
  userId: string;
}

export interface LeaveRideMessage {
  rideId: string;
}

export interface BroadcastCaptainLocationMessage {
  rideId: string;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  timestamp: string;
}

export interface ConfirmArrivalMessage {
  rideId: string;
}

export interface RequestTerminationMessage {
  rideId: string;
  reason: string;
  initiator: 'rider' | 'driver';
  latitude?: number;
  longitude?: number;
}

export interface ResolveTerminationMessage {
  rideId: string;
  accept: boolean;
}

const TERMINATION_REASON_FALLBACK = 'ظرف طارئ';
const INVALID_USER_CLAIM = '__invalid_user_claim__';

/** Socket.IO may deliver a string, an object, or a one-element array of either. */
export function unwrapSocketBody(body: unknown): unknown {
  if (Array.isArray(body)) return body[0];
  return body;
}

export function isSocketRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readScalarId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function readRideId(body: unknown): string {
  const raw = unwrapSocketBody(body);
  if (typeof raw === 'string') return raw.trim();
  if (!isSocketRecord(raw)) return '';
  return readScalarId(raw.rideId);
}

/**
 * A missing claim stays empty so the verified token is used.
 * A present non-scalar claim stays non-empty so it cannot skip the identity check.
 */
function readClaimedUserId(body: unknown): string {
  const raw = unwrapSocketBody(body);
  if (!isSocketRecord(raw)) return '';
  const value = raw.userId;
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return INVALID_USER_CLAIM;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readTimestamp(value: unknown, now: () => string): string {
  if (typeof value === 'string') return value.trim() ? value : now();
  if (typeof value === 'number' && value !== 0 && Number.isFinite(value)) return String(value);
  return now();
}

function readReason(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return TERMINATION_REASON_FALLBACK;
}

export function parseJoinRide(body: unknown): JoinRideMessage {
  return {
    rideId: readRideId(body),
    userId: readClaimedUserId(body),
  };
}

export function parseLeaveRide(body: unknown): LeaveRideMessage {
  return { rideId: readRideId(body) };
}

export function parseConfirmArrival(body: unknown): ConfirmArrivalMessage {
  return { rideId: readRideId(body) };
}

export function parseBroadcastCaptainLocation(
  body: unknown,
  now: () => string = () => new Date().toISOString(),
): BroadcastCaptainLocationMessage | null {
  const raw = unwrapSocketBody(body);
  if (!isSocketRecord(raw)) return null;
  const rideId = readScalarId(raw.rideId);
  const latitude = readFiniteNumber(raw.latitude);
  const longitude = readFiniteNumber(raw.longitude);
  if (!rideId || latitude === undefined || longitude === undefined) return null;
  const heading = readFiniteNumber(raw.heading);
  const speed = readFiniteNumber(raw.speed);
  return {
    rideId,
    latitude,
    longitude,
    ...(heading !== undefined ? { heading } : {}),
    ...(speed !== undefined ? { speed } : {}),
    timestamp: readTimestamp(raw.timestamp, now),
  };
}

export function parseRequestTermination(body: unknown): RequestTerminationMessage {
  const raw = unwrapSocketBody(body);
  if (!isSocketRecord(raw)) {
    return { rideId: '', reason: TERMINATION_REASON_FALLBACK, initiator: 'rider' };
  }
  const latitude = readFiniteNumber(raw.latitude);
  const longitude = readFiniteNumber(raw.longitude);
  return {
    rideId: readScalarId(raw.rideId),
    reason: readReason(raw.reason),
    initiator: raw.initiator === 'driver' ? 'driver' : 'rider',
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
  };
}

export function parseResolveTermination(body: unknown): ResolveTerminationMessage {
  const raw = unwrapSocketBody(body);
  if (!isSocketRecord(raw)) return { rideId: '', accept: false };
  return {
    rideId: readScalarId(raw.rideId),
    accept: raw.accept === true,
  };
}
