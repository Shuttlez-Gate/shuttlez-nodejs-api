import { readFileSync } from 'fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split <= 0 || line.startsWith('#')) continue;
    const key = line.slice(0, split).trim();
    if (!process.env[key]) process.env[key] = line.slice(split + 1).trim();
  }
}

loadEnv();

const riderId = 'adb47b6d-fc2d-4693-9974-610160910229';
const captainId = '66baf66d-08eb-4039-800e-d80aa39a5d0a';

async function time(label, fn) {
  const started = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - started);
  const json = JSON.stringify(value);
  return { label, ms, bytes: Buffer.byteLength(json), summary: summarize(value) };
}

function summarize(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.trips)) {
    return { trips: value.trips.length, polyline: value.trips.some((trip) => trip.encodedPolyline) };
  }
  return {
    page: value.page,
    pageSize: value.pageSize,
    items: Array.isArray(value.items) ? value.items.length : undefined,
    totalCount: value.totalCount,
    hasNextPage: value.hasNextPage,
    ids: Array.isArray(value.items) ? value.items.map((item) => item.id ?? item.ride?.id ?? item.booking?.tripId).slice(0, 3) : undefined,
  };
}

async function main() {
  const { loadRiderHistoryPage } = await import('../dist/modules/bookings/rider-history-page.js');
  const { loadCaptainHistoryPage } = await import('../dist/modules/drivers/captain-history-page.js');
  const { loadCaptainHomeBoard } = await import('../dist/modules/drivers/captain-home-board.js');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const driver = await prisma.driver.findUnique({
    where: { id: captainId },
    include: { vehicle: true },
  });
  const results = [];
  results.push(await time('rider-history-page-1', () => loadRiderHistoryPage(prisma, riderId, { bucket: 'past', page: 1, pageSize: 10 })));
  results.push(await time('rider-history-page-2', () => loadRiderHistoryPage(prisma, riderId, { bucket: 'past', page: 2, pageSize: 10 })));
  results.push(await time('rider-history-completed', () => loadRiderHistoryPage(prisma, riderId, { bucket: 'past', page: 1, pageSize: 10, status: 'completed' })));
  results.push(await time('captain-history-page-1', () => loadCaptainHistoryPage(prisma, captainId, { bucket: 'past', page: 1, pageSize: 10, kind: 'shuttle' })));
  results.push(await time('captain-history-page-2', () => loadCaptainHistoryPage(prisma, captainId, { bucket: 'past', page: 2, pageSize: 10, kind: 'shuttle' })));
  results.push(await time('captain-history-all-page-1', () => loadCaptainHistoryPage(prisma, captainId, { bucket: 'past', page: 1, pageSize: 10 })));
  if (driver) {
    results.push(await time('captain-home', () => loadCaptainHomeBoard(prisma, driver)));
  }
  const fullStarted = performance.now();
  const full = await prisma.trip.findMany({
    where: { driverId: captainId, isDeleted: false },
    include: {
      route: { include: { stops: { where: { isDeleted: false } } } },
      bookings: { where: { isDeleted: false }, include: { user: { select: { fullName: true } } } },
    },
  });
  results.push({
    label: 'captain-full-trips-query',
    ms: Math.round(performance.now() - fullStarted),
    bytes: Buffer.byteLength(JSON.stringify(full)),
    summary: { trips: full.length, polyline: full.some((trip) => Boolean(trip.route?.encodedPolyline)) },
  });
  console.log(JSON.stringify(results, null, 2));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'timing failed');
  process.exit(1);
});
