import { IncomingMessage, ServerResponse } from 'http';

const WINDOW_MS = 60_000;
const MAX = 12;
const counters = new Map<string, { start: number; count: number }>();

export function driverTripsRateLimit(
  req: IncomingMessage & { user?: { userId?: string }; originalUrl?: string; url?: string },
  res: ServerResponse,
  next: () => void,
): void {
  const url = req.originalUrl ?? req.url ?? '';
  if (req.method !== 'GET' || !url.startsWith('/api/v1/drivers/me/trips')) {
    next();
    return;
  }

  const userId = req.user?.userId;
  const key = userId ? `u:${userId}` : `ip:${req.socket.remoteAddress ?? 'unknown'}`;
  const now = Date.now();
  const current = counters.get(key);
  if (!current || now - current.start >= WINDOW_MS) {
    counters.set(key, { start: now, count: 1 });
    next();
    return;
  }
  if (current.count >= MAX) {
    res.statusCode = 429;
    res.setHeader('Retry-After', '60');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        message: 'تم تجاوز حد الطلبات. استخدم SignalR بدل polling.',
        errors: [],
      }),
    );
    return;
  }
  current.count += 1;
  next();
}
