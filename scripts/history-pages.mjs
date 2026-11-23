import { readFileSync } from 'fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

function loadEnv() {
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

function ids(page) {
  return page.items.map((item) => item.id ?? item.ride?.id ?? item.booking?.tripId);
}

async function main() {
  const { loadRiderHistoryPage } = await import('../dist/modules/bookings/rider-history-page.js');
  const { loadCaptainHistoryPage } = await import('../dist/modules/drivers/captain-history-page.js');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const rider = [];
  for (const page of [1, 2, 3, 4]) {
    rider.push(await loadRiderHistoryPage(prisma, riderId, { bucket: 'past', page, pageSize: 10 }));
  }
  const captain = [];
  for (const page of [1, 2, 3, 4]) {
    captain.push(await loadCaptainHistoryPage(prisma, captainId, { bucket: 'past', page, pageSize: 10 }));
  }
  const cancelled = await loadRiderHistoryPage(prisma, riderId, {
    bucket: 'past',
    page: 1,
    pageSize: 50,
    status: 'cancelled',
  });
  const stranger = await loadRiderHistoryPage(prisma, '00000000-0000-0000-0000-000000000099', {
    bucket: 'past',
    page: 1,
    pageSize: 10,
  });
  const riderIds = rider.flatMap(ids);
  const captainIds = captain.flatMap(ids);
  console.log(JSON.stringify({
    rider: rider.map((page) => ({
      page: page.page,
      items: page.items.length,
      total: page.totalCount,
      hasNext: page.hasNextPage,
    })),
    riderUnique: new Set(riderIds).size,
    riderReturned: riderIds.length,
    captain: captain.map((page) => ({
      page: page.page,
      items: page.items.length,
      total: page.totalCount,
      hasNext: page.hasNextPage,
    })),
    captainUnique: new Set(captainIds).size,
    captainReturned: captainIds.length,
    cancelledTotal: cancelled.totalCount,
    strangerTotal: stranger.totalCount,
  }));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : 'check failed');
  process.exit(1);
});
