import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const expectedDatabase = 'shuttlez_integration_test';
const expectedHost = '127.0.0.1';
const expectedPort = 54329;
const apiBase = 'http://127.0.0.1:3000';
const adminPhone = '+201000000099';
const riderPhone = '+201000000101';
const captainPhone = '+201000000102';

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
  throw new Error('Refusing to register: URL is not the isolated test database');
}

const prisma = new PrismaClient({ datasources: { db: { url: rawUrl } } });

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function post(pathname, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function patch(pathname, body, token) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function registerPassenger(phone, fullName) {
  const existing = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, userType: true, isActive: true, isDeleted: true },
  });
  if (existing) {
    return { action: 'existing', ...existing };
  }
  const otp = await post('/api/v1/auth/send-otp', { phone, purpose: 'register' });
  const code = otp.payload?.data?.debugCode;
  if (!otp.payload?.success || typeof code !== 'string' || code.length !== 4) {
    throw new Error(`Rider OTP was not issued (${otp.status})`);
  }
  const created = await post('/api/v1/auth/register', {
    phone,
    fullName,
    email: null,
    gender: 'ذكر',
    code,
  });
  if (!created.payload?.success) {
    throw new Error(`Rider registration failed (${created.status})`);
  }
  const user = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, userType: true, isActive: true, isDeleted: true },
  });
  return { action: 'created', ...user };
}

async function registerCaptain(phone) {
  const existing = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, userType: true, isActive: true, isDeleted: true },
  });
  if (!existing) {
    const otp = await post('/api/v1/auth/send-otp', {
      phone,
      purpose: 'register',
      client: 'driver',
    });
    const code = otp.payload?.data?.debugCode;
    if (!otp.payload?.success || typeof code !== 'string' || code.length !== 4) {
      throw new Error(`Captain OTP was not issued (${otp.status})`);
    }
    const created = await post('/api/v1/auth/register', {
      phone,
      fullName: 'Integration Test Captain',
      email: null,
      gender: 'ذكر',
      code,
      userType: 'driver',
      client: 'driver',
      deviceId: 'integration-test-captain-device',
      vehicleKind: 'car',
      vehicleModel: 'Test Car',
      manufactureYear: 2020,
      plateNumber: 'T-E2E102',
      vehicleColor: 'white',
      seats: 4,
    });
    if (!created.payload?.success) {
      throw new Error(`Captain registration failed (${created.status})`);
    }
  }
  const user = await prisma.user.findUnique({
    where: { phone },
    select: { id: true, userType: true, isActive: true, isDeleted: true },
  });
  const driver = await prisma.driver.findFirst({
    where: { userId: user.id, isDeleted: false },
    select: {
      id: true,
      isActive: true,
      isOnline: true,
      verificationStatus: true,
      vehicleKind: true,
    },
  });
  return {
    action: existing ? 'existing' : 'created',
    user,
    driver,
  };
}

try {
  const identity = await prisma.$queryRawUnsafe(
    'SELECT current_database() AS db, inet_server_port() AS port',
  );
  const db = identity[0]?.db;
  const port = Number(identity[0]?.port);
  if (db !== expectedDatabase || port !== expectedPort) {
    throw new Error('Refusing to register: connection is not the isolated test database');
  }

  const rider = await registerPassenger(riderPhone, 'Integration Test Rider');
  const captain = await registerCaptain(captainPhone);
  if (!captain.driver) {
    throw new Error('Captain registration did not create a driver');
  }

  const adminOtp = await post('/api/v1/admin/auth/send-otp', { phone: adminPhone });
  const adminCode = adminOtp.payload?.data?.debugCode;
  if (!adminOtp.payload?.success || typeof adminCode !== 'string') {
    throw new Error(`Admin OTP was not issued (${adminOtp.status})`);
  }
  const login = await post('/api/v1/admin/auth/login', {
    phone: adminPhone,
    code: adminCode,
  });
  const token = login.payload?.data?.accessToken;
  if (!login.payload?.success || typeof token !== 'string' || login.payload?.data?.admin?.role !== 'Admin') {
    throw new Error(`Admin login failed (${login.status})`);
  }

  const approved = await patch(
    `/api/v1/admin/drivers/${captain.driver.id}`,
    { isActive: true, verificationStatus: 'approved' },
    token,
  );
  const responseDriver = approved.payload?.data;
  const stored = await prisma.driver.findFirst({
    where: { id: captain.driver.id, isDeleted: false },
    select: {
      id: true,
      isActive: true,
      isOnline: true,
      verificationStatus: true,
      vehicleKind: true,
      userId: true,
    },
  });

  const report = {
    db,
    port,
    rider: {
      action: rider.action,
      id: rider.id,
      userType: rider.userType,
      isActive: rider.isActive,
      isDeleted: rider.isDeleted,
    },
    captain: {
      action: captain.action,
      userId: captain.user.id,
      userType: captain.user.userType,
      driverId: captain.driver.id,
      vehicleKindBeforeApproval: captain.driver.vehicleKind,
    },
    approval: {
      status: approved.status,
      success: approved.payload?.success === true,
      responseIsActive: responseDriver?.isActive ?? null,
      responseVerificationStatus: responseDriver?.verificationStatus ?? null,
      responseVehicleKind: responseDriver?.vehicleKind ?? null,
    },
    storedDriver: stored,
  };
  console.log(JSON.stringify(report));
  if (
    rider.userType !== 1 ||
    captain.user.userType !== 2 ||
    captain.driver.vehicleKind !== 'car' ||
    approved.status !== 200 ||
    report.approval.success !== true ||
    report.approval.responseVerificationStatus !== 'Approved' ||
    report.approval.responseIsActive !== true ||
    stored?.isActive !== true ||
    stored?.verificationStatus !== 1 ||
    stored?.vehicleKind !== 'car'
  ) {
    fail('Registration or approval did not match the expected isolated state');
  }
} finally {
  await prisma.$disconnect();
}
