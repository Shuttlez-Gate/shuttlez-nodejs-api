import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const expectedDatabase = 'shuttlez_integration_test';
const expectedHost = '127.0.0.1';
const expectedPort = 54329;
const testPhone = '+201000000099';
const testName = 'Integration Test Admin';
const adminType = 3;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawUrl = fs
  .readFileSync(path.join(root, '.local', 'pg-test', 'database-url'), 'utf8')
  .trim();
const source = new URL(rawUrl);
if (
  source.hostname !== expectedHost ||
  source.port !== String(expectedPort) ||
  source.pathname !== `/${expectedDatabase}`
) {
  throw new Error('Refusing to write: URL is not the isolated test database');
}

const prisma = new PrismaClient({ datasources: { db: { url: rawUrl } } });

try {
  const identity = await prisma.$queryRawUnsafe(
    'SELECT current_database() AS db, inet_server_port() AS port',
  );
  const db = identity[0]?.db;
  const port = Number(identity[0]?.port);
  if (db !== expectedDatabase || port !== expectedPort) {
    throw new Error('Refusing to write: connection is not the isolated test database');
  }

  const existing = await prisma.user.findUnique({ where: { phone: testPhone } });
  const activeAdmins = await prisma.user.count({
    where: { userType: adminType, isDeleted: false, isActive: true },
  });

  let action = 'unchanged';
  if (!existing) {
    if (activeAdmins > 0) {
      throw new Error('Refusing to write: an active admin already exists');
    }
    await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        phone: testPhone,
        fullName: testName,
        userType: adminType,
        ratingAverage: 0,
        ratingCount: 0,
        isActive: true,
        isDeleted: false,
        createdAt: new Date(),
      },
    });
    action = 'created';
  } else if (existing.userType !== adminType || existing.isDeleted) {
    throw new Error('Refusing to write: test phone is not an active admin candidate');
  } else if (!existing.isActive) {
    if (activeAdmins > 0) {
      throw new Error('Refusing to write: an active admin already exists');
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: { isActive: true, updatedAt: new Date() },
    });
    action = 'reactivated';
  }

  const admin = await prisma.user.findFirst({
    where: {
      phone: testPhone,
      userType: adminType,
      isDeleted: false,
      isActive: true,
    },
    select: { userType: true, isActive: true, isDeleted: true },
  });
  if (!admin) {
    throw new Error('Test admin was not active after bootstrap');
  }
  const adminCount = await prisma.user.count({
    where: { userType: adminType, isDeleted: false, isActive: true },
  });
  console.log(
    JSON.stringify({
      db,
      port,
      action,
      userType: admin.userType,
      isActive: admin.isActive,
      isDeleted: admin.isDeleted,
      activeAdmins: adminCount,
    }),
  );
} finally {
  await prisma.$disconnect();
}
