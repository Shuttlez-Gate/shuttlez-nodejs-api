import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const expectedDatabase = 'shuttlez_integration_test';
const expectedHost = '127.0.0.1';
const expectedPort = 54329;
const testPhone = '+201000000099';
const apiBase = 'http://127.0.0.1:3000';

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
  throw new Error('Refusing to verify: URL is not the isolated test database');
}

const prisma = new PrismaClient({ datasources: { db: { url: rawUrl } } });

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

try {
  const healthResponse = await fetch(`${apiBase}/api/v1/health`);
  const health = await healthResponse.json();
  const identity = await prisma.$queryRawUnsafe(
    'SELECT current_database() AS db, inet_server_port() AS port',
  );
  const db = identity[0]?.db;
  const port = Number(identity[0]?.port);
  if (db !== expectedDatabase || port !== expectedPort) {
    throw new Error('Refusing to verify: connection is not the isolated test database');
  }

  const before = await prisma.otpRequest.count({
    where: { phone: testPhone, purpose: 1, isDeleted: false },
  });
  const sendResponse = await fetch(`${apiBase}/api/v1/admin/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: testPhone }),
  });
  const sendBody = await sendResponse.json();
  const code = sendBody?.data?.debugCode;
  const afterSend = await prisma.otpRequest.count({
    where: { phone: testPhone, purpose: 1, isDeleted: false, isUsed: false },
  });

  let loginStatus = null;
  let role = null;
  let loginSuccess = false;
  if (sendResponse.ok && typeof code === 'string' && code.length > 0) {
    const loginResponse = await fetch(`${apiBase}/api/v1/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: testPhone, code }),
    });
    loginStatus = loginResponse.status;
    const loginBody = await loginResponse.json();
    loginSuccess = loginBody?.success === true;
    role = loginBody?.data?.admin?.role ?? null;
  }

  const used = await prisma.otpRequest.count({
    where: { phone: testPhone, purpose: 1, isDeleted: false, isUsed: true },
  });
  const admin = await prisma.user.findFirst({
    where: { phone: testPhone, isDeleted: false },
    select: { id: true, userType: true, isActive: true },
  });
  const refreshTokens = admin
    ? await prisma.refreshToken.count({
        where: { userId: admin.id, isDeleted: false, revokedAt: null },
      })
    : 0;

  const report = {
    db,
    port,
    healthStatus: healthResponse.status,
    health: health?.data?.status ?? null,
    service: health?.data?.service ?? null,
    sendStatus: sendResponse.status,
    sendSucceeded: sendResponse.ok === true && sendBody?.success === true,
    otpCreated: afterSend > before,
    loginStatus,
    loginSucceeded: loginSuccess,
    role,
    otpConsumed: used > 0,
    activeRefreshTokens: refreshTokens,
    adminUserType: admin?.userType ?? null,
    adminIsActive: admin?.isActive ?? null,
  };
  console.log(JSON.stringify(report));
  if (
    report.healthStatus !== 200 ||
    report.health !== 'healthy' ||
    !report.sendSucceeded ||
    !report.otpCreated ||
    !report.loginSucceeded ||
    report.role !== 'Admin' ||
    !report.otpConsumed
  ) {
    fail('Admin OTP login did not complete against the isolated database');
  }
} finally {
  await prisma.$disconnect();
}
