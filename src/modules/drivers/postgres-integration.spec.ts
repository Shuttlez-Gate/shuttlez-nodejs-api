import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createServer } from 'node:http';
import { Prisma, PrismaClient } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server } from 'socket.io';
import { io as ioClient, Socket } from 'socket.io-client';
import { CurrentUserService } from '../../common/current-user.service';
import { RideRequestStatus, TripStatus, GroupRequestStatus, RouteOwnerType } from '../../common/enums';
import { newId } from '../../common/utils/date.util';
import { userDefaults, driverDefaults, baseFields } from '../../common/utils/entity-defaults';
import { PrismaService } from '../../database/prisma/prisma.service';
import { DriversService } from './drivers.service';
import { RidesService } from '../rides/rides.service';
import { BookingsController } from '../bookings/bookings.controller';
import { AdminGroupsController } from '../admin/admin-support.controller';
import { AdminTripsController } from '../admin/admin-operations.controller';
import { CorridorDemandService } from '../admin/corridor-demand.service';
import { CaptainRoutesService } from '../marketplace/captain-routes.service';
import { SupportController } from '../support/support.controller';
import { SupportChatGateway } from '../realtime/realtime.gateway';
import { SocketIdentity } from '../realtime/socket-identity';
import { FareService } from '../pricing/fare.service';
import { GroupsService } from '../groups/groups.service';
import { SegmentInventoryService } from '../marketplace/segment-inventory.service';
import { PushNotificationService } from '../marketplace/push-notification.service';
import { createNestApp } from '../../create-app';

jest.setTimeout(120000);

const urlPath = path.resolve(__dirname, '../../../.local/pg-test/database-url');
const databaseUrl = readFileSync(urlPath, 'utf8').trim();
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const db = prisma as unknown as PrismaService;

function asUser(userId: string): CurrentUserService {
  return {
    get userId() {
      return userId;
    },
    requireUserId: () => userId,
    get isAuthenticated() {
      return true;
    },
  } as CurrentUserService;
}

function money() {
  return {
    fareAmount: new Prisma.Decimal(25),
    commissionRate: new Prisma.Decimal(0),
    commissionAmount: new Prisma.Decimal(0),
    captainEarnings: new Prisma.Decimal(25),
    totalAmount: new Prisma.Decimal(25),
  };
}

async function createUser(phone: string) {
  return prisma.user.create({
    data: {
      id: newId(),
      phone,
      fullName: 'Integration',
      userType: 1,
      ...userDefaults(),
    },
  });
}

async function createCaptain(phone: string, online: boolean, vehicleKind = 'car') {
  const user = await createUser(phone);
  const vehicle = await prisma.vehicle.create({
    data: {
      id: newId(),
      plateNumber: `T-${phone.slice(-4)}`,
      model: 'Test',
      type: vehicleKind === 'scooter' ? 4 : 1,
      capacity: 4,
      isActive: true,
      ...baseFields(),
    },
  });
  const driver = await prisma.driver.create({
    data: {
      id: newId(),
      userId: user.id,
      vehicleId: vehicle.id,
      isActive: true,
      vehicleKind,
      seats: 4,
      ...driverDefaults(),
      isOnline: online,
    },
  });
  return { user, vehicle, driver };
}

async function createRide(riderId: string, kind = 'private_car') {
  return prisma.rideRequest.create({
    data: {
      id: newId(),
      riderUserId: riderId,
      pickupLatitude: 30.05,
      pickupLongitude: 31.24,
      destinationLatitude: 30.08,
      destinationLongitude: 31.28,
      status: RideRequestStatus.Requested,
      paymentMethod: 'cash',
      isCashConfirmed: false,
      requestedVehicleKind: kind,
      ...money(),
      ...baseFields(),
    },
  });
}

function driversFor(userId: string) {
  return new DriversService(
    db,
    asUser(userId),
    new RidesService(db, asUser(userId), {} as FareService),
    {} as GroupsService,
  );
}

function ridesFor(userId: string) {
  return new RidesService(db, asUser(userId), {} as FareService);
}

function routeService(userId: string) {
  return new CaptainRoutesService(
    db,
    asUser(userId),
    { get: () => undefined } as unknown as ConfigService,
    {} as SegmentInventoryService,
    { notifyUser: async () => undefined } as unknown as PushNotificationService,
    { pricePerKmForVehicle: async () => null, distanceKm: () => 1 } as unknown as FareService,
  );
}

function ownedRoute(driverId: string, name: string) {
  return prisma.route.create({
    data: {
      id: newId(),
      name,
      startLatitude: 30,
      startLongitude: 31,
      endLatitude: 30.2,
      endLongitude: 31.2,
      isActive: true,
      ownerType: RouteOwnerType.Captain,
      ownerDriverId: driverId,
      capacity: 4,
      vehicleKind: 'car',
      ...baseFields(),
      stops: {
        create: [
          { id: newId(), name: 'A', order: 1, latitude: 30, longitude: 31, ...baseFields() },
          { id: newId(), name: 'B', order: 2, latitude: 30.2, longitude: 31.2, ...baseFields() },
        ],
      },
    },
  });
}

async function outcome<T>(work: Promise<T>) {
  try {
    return { ok: true as const, value: await work };
  } catch (error) {
    return { ok: false as const, error };
  }
}

describe('PostgreSQL integration', () => {
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const identity = await prisma.$queryRaw<Array<{ db: string; port: number }>>`
      SELECT current_database() AS db, inet_server_port() AS port`;
    if (identity[0]?.db !== 'shuttlez_integration_test' || Number(identity[0]?.port) !== 54329) {
      throw new Error('Refusing to run: connection is not the isolated test database');
    }
    db.markTripFullIfNeeded = async () => undefined;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    const platformRoutes = await prisma.route.findMany({
      where: { name: { in: ['Platform shuttle', 'Corridor line'] } },
      select: { id: true },
    });
    const platformIds = platformRoutes.map((route) => route.id);
    if (platformIds.length > 0) {
      await prisma.tripSegmentInventory.deleteMany({ where: { trip: { routeId: { in: platformIds } } } });
      await prisma.trip.deleteMany({ where: { routeId: { in: platformIds } } });
      await prisma.route.deleteMany({ where: { id: { in: platformIds } } });
    }
    if (createdUsers.length === 0) return;
    const ids = [...createdUsers];
    createdUsers.length = 0;
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: { in: ids } } } });
    await prisma.supportTicket.deleteMany({ where: { userId: { in: ids } } });
    await prisma.booking.deleteMany({ where: { userId: { in: ids } } });
    await prisma.rideRequest.deleteMany({
      where: { OR: [{ riderUserId: { in: ids } }, { driver: { userId: { in: ids } } }] },
    });
    await prisma.groupRequest.deleteMany({
      where: { OR: [{ organizerUserId: { in: ids } }, { driver: { userId: { in: ids } } }] },
    });
    await prisma.tripSegmentInventory.deleteMany({ where: { trip: { driver: { userId: { in: ids } } } } });
    await prisma.trip.deleteMany({ where: { driver: { userId: { in: ids } } } });
    await prisma.route.deleteMany({ where: { ownerDriver: { userId: { in: ids } } } });
    await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
    await prisma.vehicle.deleteMany({ where: { drivers: { none: {} }, plateNumber: { startsWith: 'T-' } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('has the pushed tables, foreign keys, and indexes', async () => {
    const [tables, foreignKeys, indexes] = await Promise.all([
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM pg_constraint WHERE contype = 'f'`,
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'`,
    ]);
    expect(tables[0].count).toBeGreaterThanOrEqual(39);
    expect(foreignKeys[0].count).toBeGreaterThan(20);
    expect(indexes[0].count).toBeGreaterThan(20);
  });

  it('lets only one of two captains persist an accept', async () => {
    const rider = await createUser(`0191${Date.now().toString().slice(-7)}`);
    const first = await createCaptain(`0192${Date.now().toString().slice(-7)}`, true);
    const second = await createCaptain(`0193${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(rider.id, first.user.id, second.user.id);
    const ride = await createRide(rider.id);

    const [a, b] = await Promise.all([
      outcome(driversFor(first.user.id).acceptRide(ride.id)),
      outcome(driversFor(second.user.id).acceptRide(ride.id)),
    ]);
    const wins = [a, b].filter((item) => item.ok);
    expect(wins).toHaveLength(1);

    const stored = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(stored.status).toBe(RideRequestStatus.Assigned);
    expect([first.driver.id, second.driver.id]).toContain(stored.driverId);
  });

  it('treats a repeated accept by the assigned captain as the same row', async () => {
    const rider = await createUser(`0194${Date.now().toString().slice(-7)}`);
    const captain = await createCaptain(`0195${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(rider.id, captain.user.id);
    const ride = await createRide(rider.id);
    const service = driversFor(captain.user.id);
    await service.acceptRide(ride.id);
    const [again, parallel] = await Promise.all([
      outcome(service.acceptRide(ride.id)),
      outcome(service.acceptRide(ride.id)),
    ]);
    expect(again.ok).toBe(true);
    expect(parallel.ok).toBe(true);
    const stored = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(stored.status).toBe(RideRequestStatus.Assigned);
    expect(stored.driverId).toBe(captain.driver.id);
    expect(await prisma.rideRequest.count({ where: { id: ride.id } })).toBe(1);
  });

  it('rejects acceptance after cancellation and keeps a second cancel idempotent', async () => {
    const rider = await createUser(`0190${Date.now().toString().slice(-7)}`);
    const captain = await createCaptain(`0189${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(rider.id, captain.user.id);
    const ride = await createRide(rider.id);
    const offers = await driversFor(captain.user.id).pendingNearbyRides(30.05, 31.24, 5);
    expect(offers.map((item) => item.id)).toContain(ride.id);

    await ridesFor(rider.id).cancel(ride.id);
    const denied = await outcome(driversFor(captain.user.id).acceptRide(ride.id));
    expect(denied.ok).toBe(false);
    await ridesFor(rider.id).cancel(ride.id);

    const stored = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(stored.status).toBe(RideRequestStatus.Cancelled);
    expect(stored.driverId).toBeNull();
    const after = await driversFor(captain.user.id).pendingNearbyRides(30.05, 31.24, 5);
    expect(after.map((item) => item.id)).not.toContain(ride.id);
  });

  it('keeps one persisted status when accept races cancellation', async () => {
    const rider = await createUser(`0196${Date.now().toString().slice(-7)}`);
    const captain = await createCaptain(`0197${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(rider.id, captain.user.id);
    const ride = await createRide(rider.id);
    await Promise.all([
      outcome(driversFor(captain.user.id).acceptRide(ride.id)),
      outcome(ridesFor(rider.id).cancel(ride.id)),
    ]);
    const stored = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect([RideRequestStatus.Assigned, RideRequestStatus.Cancelled]).toContain(stored.status);
    if (stored.status === RideRequestStatus.Cancelled) {
      expect(stored.cancelledAt).not.toBeNull();
    }
    if (stored.status === RideRequestStatus.Assigned) {
      expect(stored.driverId).toBe(captain.driver.id);
    }
  });

  it('does not complete a ride that was not assigned, and complete after accept stays completed', async () => {
    const rider = await createUser(`0198${Date.now().toString().slice(-7)}`);
    const captain = await createCaptain(`0181${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(rider.id, captain.user.id);
    const unassigned = await createRide(rider.id);
    const raced = await Promise.all([
      outcome(driversFor(captain.user.id).acceptRide(unassigned.id)),
      outcome(driversFor(captain.user.id).completeRide(unassigned.id)),
    ]);
    const stored = await prisma.rideRequest.findUniqueOrThrow({ where: { id: unassigned.id } });
    expect(stored.driverId === null || stored.driverId === captain.driver.id).toBe(true);
    expect([RideRequestStatus.Requested, RideRequestStatus.Assigned, RideRequestStatus.Completed]).toContain(
      stored.status,
    );
    if (stored.status === RideRequestStatus.Completed) {
      expect(stored.driverId).toBe(captain.driver.id);
    }
    expect(raced.some((item) => item.ok)).toBe(true);
    if (stored.status === RideRequestStatus.Assigned) {
      await driversFor(captain.user.id).completeRide(unassigned.id);
    }

    const second = await createRide(rider.id);
    const service = driversFor(captain.user.id);
    await service.acceptRide(second.id);
    await service.completeRide(second.id);
    const finished = await prisma.rideRequest.findUniqueOrThrow({ where: { id: second.id } });
    expect(finished.status).toBe(RideRequestStatus.Completed);
    const rejected = await outcome(service.acceptRide(second.id));
    expect(rejected.ok).toBe(false);
    const after = await prisma.rideRequest.findUniqueOrThrow({ where: { id: second.id } });
    expect(after.status).toBe(RideRequestStatus.Completed);
  });

  it('hides offers from an offline captain and shows a nearby online captain', async () => {
    const rider = await createUser(`0182${Date.now().toString().slice(-7)}`);
    const captain = await createCaptain(`0183${Date.now().toString().slice(-7)}`, false);
    createdUsers.push(rider.id, captain.user.id);
    const ride = await createRide(rider.id, 'group_car');
    const service = driversFor(captain.user.id);
    await service.setAvailability(false);
    expect(await service.pendingNearbyRides(30.05, 31.24, 5)).toEqual([]);
    const denied = await outcome(service.acceptRide(ride.id));
    expect(denied.ok).toBe(false);
    await service.setAvailability(true);
    const offers = await service.pendingNearbyRides(30.05, 31.24, 5);
    expect(offers.map((item) => item.id)).toContain(ride.id);
    const far = await service.pendingNearbyRides(29.0, 30.0, 5);
    expect(far.map((item) => item.id)).not.toContain(ride.id);
  });

  it('rejects a car captain for a scooter request and accepts group_car', async () => {
    const rider = await createUser(`0184${Date.now().toString().slice(-7)}`);
    const captain = await createCaptain(`0185${Date.now().toString().slice(-7)}`, true, 'car');
    createdUsers.push(rider.id, captain.user.id);
    const scooter = await createRide(rider.id, 'scooter');
    const denied = await outcome(driversFor(captain.user.id).acceptRide(scooter.id));
    expect(denied.ok).toBe(false);
    expect((await prisma.rideRequest.findUniqueOrThrow({ where: { id: scooter.id } })).status).toBe(
      RideRequestStatus.Requested,
    );
    const groupCar = await createRide(rider.id, 'group_car');
    await driversFor(captain.user.id).acceptRide(groupCar.id);
    expect((await prisma.rideRequest.findUniqueOrThrow({ where: { id: groupCar.id } })).driverId).toBe(
      captain.driver.id,
    );
  });

  it('gives the last shuttle seat to one booking and rejects a duplicate', async () => {
    const captain = await createCaptain(`0186${Date.now().toString().slice(-7)}`, true);
    const firstRider = await createUser(`0187${Date.now().toString().slice(-7)}`);
    const secondRider = await createUser(`0188${Date.now().toString().slice(-7)}`);
    createdUsers.push(captain.user.id, firstRider.id, secondRider.id);
    const route = await prisma.route.create({
      data: {
        id: newId(),
        name: 'Test shuttle',
        startLatitude: 30,
        startLongitude: 31,
        endLatitude: 30.1,
        endLongitude: 31.1,
        isActive: true,
        ownerType: RouteOwnerType.Platform,
        ...baseFields(),
      },
    });
    const trip = await prisma.trip.create({
      data: {
        id: newId(),
        routeId: route.id,
        driverId: captain.driver.id,
        status: TripStatus.Scheduled,
        scheduledAt: new Date(Date.now() + 3_600_000),
        pricePerSeat: new Prisma.Decimal(15),
        availableSeats: 1,
        ...baseFields(),
      },
    });
    const bookings = new BookingsController(
      db,
      asUser(firstRider.id),
      { platformCommissionPercent: async () => 0 } as FareService,
      {} as SegmentInventoryService,
      { notifyUser: async () => undefined } as unknown as PushNotificationService,
    );
    const other = new BookingsController(
      db,
      asUser(secondRider.id),
      { platformCommissionPercent: async () => 0 } as FareService,
      {} as SegmentInventoryService,
      { notifyUser: async () => undefined } as unknown as PushNotificationService,
    );
    const raced = await Promise.all([
      outcome(bookings.create({ tripId: trip.id, seatCount: 1, paymentMethod: 'cash' })),
      outcome(other.create({ tripId: trip.id, seatCount: 1, paymentMethod: 'cash' })),
    ]);
    expect(raced.filter((item) => item.ok)).toHaveLength(1);
    const stored = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(stored.availableSeats).toBe(0);
    expect(await prisma.booking.count({ where: { tripId: trip.id, isDeleted: false } })).toBe(1);

    const duplicate = await outcome(
      bookings.create({ tripId: trip.id, seatCount: 1, paymentMethod: 'cash' }),
    );
    expect(duplicate.ok).toBe(false);
    expect(await prisma.booking.count({ where: { tripId: trip.id, isDeleted: false } })).toBe(1);
  });

  it('does not generate a second trip for the same captain-route occurrence', async () => {
    const captain = await createCaptain(`0171${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(captain.user.id);
    const route = await prisma.route.create({
      data: {
        id: newId(),
        name: 'Captain route',
        startLatitude: 30,
        startLongitude: 31,
        endLatitude: 30.2,
        endLongitude: 31.2,
        isActive: true,
        ownerType: RouteOwnerType.Captain,
        ownerDriverId: captain.driver.id,
        capacity: 4,
        vehicleKind: 'car',
        ...baseFields(),
        stops: {
          create: [
            { id: newId(), name: 'A', order: 1, latitude: 30, longitude: 31, ...baseFields() },
            { id: newId(), name: 'B', order: 2, latitude: 30.2, longitude: 31.2, ...baseFields() },
          ],
        },
      },
    });
    const service = new CaptainRoutesService(
      db,
      asUser(captain.user.id),
      { get: () => undefined } as unknown as ConfigService,
      {} as SegmentInventoryService,
      { notifyUser: async () => undefined } as unknown as PushNotificationService,
      { pricePerKmForVehicle: async () => null, distanceKm: () => 1 } as unknown as FareService,
    );
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const body = { routeId: route.id, scheduledAt: when, pricePerSeat: 20, recurrenceKind: 'once' };
    const first = await service.createTripsForDriver(captain.driver, body);
    const second = await service.createTripsForDriver(captain.driver, body);
    expect(first.count).toBe(1);
    expect(second.count).toBe(0);
    expect(await prisma.trip.count({ where: { routeId: route.id, isDeleted: false } })).toBe(1);
  });

  it('keeps one trip when two generations run concurrently', async () => {
    const captain = await createCaptain(`0176${Date.now().toString().slice(-7)}`, true);
    const otherCaptain = await createCaptain(`0177${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(captain.user.id, otherCaptain.user.id);
    const racedRoute = await ownedRoute(captain.driver.id, 'Concurrent captain route');
    const otherRoute = await ownedRoute(otherCaptain.driver.id, 'Other captain route');
    const service = routeService(captain.user.id);
    const otherService = routeService(otherCaptain.user.id);
    const racedWhen = new Date('2026-11-02T12:30:10.000Z');
    const racedBody = {
      routeId: racedRoute.id,
      scheduledAt: racedWhen.toISOString(),
      pricePerSeat: 20,
      recurrenceKind: 'once',
    };
    const raced = await Promise.all([
      service.createTripsForDriver(captain.driver, racedBody),
      service.createTripsForDriver(captain.driver, racedBody),
      service.createTripsForDriver(captain.driver, racedBody),
    ]);
    expect(raced.every((item) => item.count >= 0 && Array.isArray(item.tripIds))).toBe(true);
    expect(raced.reduce((sum, item) => sum + item.count, 0)).toBe(1);

    const retry = await service.createTripsForDriver(captain.driver, racedBody);
    expect(retry.count).toBe(0);
    const sameMinute = await service.createTripsForDriver(captain.driver, {
      ...racedBody,
      scheduledAt: new Date('2026-11-02T12:30:40.000Z').toISOString(),
    });
    expect(sameMinute.count).toBe(0);

    const nextDeparture = await service.createTripsForDriver(captain.driver, {
      ...racedBody,
      scheduledAt: new Date('2026-11-03T12:30:10.000Z').toISOString(),
    });
    expect(nextDeparture.count).toBe(1);
    const separateRoute = await otherService.createTripsForDriver(otherCaptain.driver, {
      routeId: otherRoute.id,
      scheduledAt: racedWhen.toISOString(),
      pricePerSeat: 20,
      recurrenceKind: 'once',
    });
    expect(separateRoute.count).toBe(1);

    const stored = await prisma.trip.findMany({
      where: { routeId: racedRoute.id, isDeleted: false },
      orderBy: { scheduledAt: 'asc' },
    });
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((trip) => trip.departureSlot)).size).toBe(2);
    expect(stored[0]?.departureSlot).toBe(stored.find((trip) => trip.id === raced.find((item) => item.count === 1)?.tripIds[0])?.departureSlot);
    expect(await prisma.trip.count({ where: { routeId: otherRoute.id, isDeleted: false } })).toBe(1);

    const duplicate = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      await expect(
        duplicate.trip.create({
          data: {
            id: newId(),
            routeId: racedRoute.id,
            driverId: captain.driver.id,
            status: TripStatus.Scheduled,
            scheduledAt: racedWhen,
            pricePerSeat: new Prisma.Decimal(20),
            availableSeats: 4,
            departureSlot: stored[0]?.departureSlot,
            ...baseFields(),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    } finally {
      await duplicate.$disconnect();
    }
    expect(await prisma.trip.count({ where: { routeId: racedRoute.id, isDeleted: false } })).toBe(2);

    const weeklyRoute = await ownedRoute(captain.driver.id, 'Weekly captain route');
    const weeklyBody = {
      routeId: weeklyRoute.id,
      scheduledAt: '2026-11-02T06:00:00.000Z',
      pricePerSeat: 20,
      recurrenceKind: 'weekly',
      daysOfWeek: [1],
      rangeStart: '2026-11-02T06:00:00.000Z',
      rangeEnd: '2026-11-16T06:00:00.000Z',
    };
    const weekly = await Promise.all([
      service.createTripsForDriver(captain.driver, weeklyBody),
      service.createTripsForDriver(captain.driver, weeklyBody),
    ]);
    const weeklyRows = await prisma.trip.findMany({
      where: { routeId: weeklyRoute.id, isDeleted: false, status: { not: TripStatus.Cancelled } },
    });
    const weeklySlots = weeklyRows.map((trip) => trip.departureSlot);
    expect(weeklySlots.length).toBeGreaterThan(1);
    expect(new Set(weeklySlots).size).toBe(weeklySlots.length);
    expect(weekly.reduce((sum, item) => sum + item.count, 0)).toBe(weeklySlots.length);
    const weeklyRetry = await service.createTripsForDriver(captain.driver, weeklyBody);
    expect(weeklyRetry.count).toBe(0);
    expect(await prisma.trip.count({ where: { routeId: weeklyRoute.id, isDeleted: false } })).toBe(weeklySlots.length);

    await prisma.trip.update({
      where: { id: stored[0]!.id },
      data: { status: TripStatus.Cancelled },
    });
    const regenerated = await service.createTripsForDriver(captain.driver, racedBody);
    expect(regenerated.count).toBe(1);
    const afterCancel = await prisma.trip.findMany({
      where: { routeId: racedRoute.id, isDeleted: false, departureSlot: stored[0]!.departureSlot },
    });
    expect(afterCancel).toHaveLength(2);
    expect(afterCancel.filter((trip) => trip.status !== TripStatus.Cancelled)).toHaveLength(1);

    const rolledBackId = newId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.trip.create({
          data: {
            id: rolledBackId,
            routeId: otherRoute.id,
            driverId: otherCaptain.driver.id,
            status: TripStatus.Scheduled,
            scheduledAt: new Date('2026-12-01T12:30:10.000Z'),
            pricePerSeat: new Prisma.Decimal(20),
            availableSeats: 4,
            departureSlot: '2026-12-01 14:30',
            ...baseFields(),
          },
        });
        throw new Error('rollback generated trip');
      }),
    ).rejects.toThrow('rollback generated trip');
    expect(await prisma.trip.findUnique({ where: { id: rolledBackId } })).toBeNull();
    expect(await prisma.trip.count({ where: { routeId: otherRoute.id, isDeleted: false } })).toBe(1);
  });

  it('does not let admin schedule duplicate a captain-route departure', async () => {
    const captain = await createCaptain(`0178${Date.now().toString().slice(-7)}`, true);
    const rider = await createUser(`0179${Date.now().toString().slice(-7)}`);
    const secondRider = await createUser(`0168${Date.now().toString().slice(-7)}`);
    createdUsers.push(captain.user.id, rider.id, secondRider.id);
    const route = await ownedRoute(captain.driver.id, 'Admin overlap route');
    const otherRoute = await ownedRoute(captain.driver.id, 'Admin other route');
    const platform = await prisma.route.create({
      data: {
        id: newId(),
        name: 'Platform shuttle',
        startLatitude: 30,
        startLongitude: 31,
        endLatitude: 30.05,
        endLongitude: 31.05,
        isActive: true,
        ownerType: RouteOwnerType.Platform,
        ...baseFields(),
      },
    });
    const service = routeService(captain.user.id);
    const admin = new AdminTripsController(db, { get: () => 'Africa/Cairo' } as unknown as ConfigService);
    const when = '2026-12-10T06:30:10.000Z';
    const schedule = {
      routeId: route.id,
      startDate: '2026-12-10',
      endDate: '2026-12-10',
      times: ['08:30'],
      pricePerSeat: 20,
      availableSeats: 4,
    };
    await service.createTripsForDriver(captain.driver, {
      routeId: route.id,
      scheduledAt: when,
      pricePerSeat: 20,
      recurrenceKind: 'once',
    });
    const afterCaptain = await admin.generate(schedule);
    expect(afterCaptain.data).toBe(0);
    expect(await prisma.trip.count({ where: { routeId: route.id, isDeleted: false } })).toBe(1);

    const reverseRoute = await ownedRoute(captain.driver.id, 'Admin first route');
    const reverseSchedule = { ...schedule, routeId: reverseRoute.id };
    const adminFirst = await admin.generate(reverseSchedule);
    expect(adminFirst.data).toBe(1);
    const captainSecond = await service.createTripsForDriver(captain.driver, {
      routeId: reverseRoute.id,
      scheduledAt: '2026-12-10T06:30:40.000Z',
      pricePerSeat: 20,
      recurrenceKind: 'once',
    });
    expect(captainSecond.count).toBe(0);
    const reverseRows = await prisma.trip.findMany({ where: { routeId: reverseRoute.id, isDeleted: false } });
    expect(reverseRows).toHaveLength(1);
    expect(reverseRows[0]?.departureSlot).toBeTruthy();

    const racedRoute = await ownedRoute(captain.driver.id, 'Cross path route');
    const racedSchedule = { ...schedule, routeId: racedRoute.id, startDate: '2026-12-11', endDate: '2026-12-11' };
    const racedWhen = '2026-12-11T06:30:10.000Z';
    const raced = await Promise.all([
      service.createTripsForDriver(captain.driver, {
        routeId: racedRoute.id,
        scheduledAt: racedWhen,
        pricePerSeat: 20,
        recurrenceKind: 'once',
      }),
      admin.generate(racedSchedule),
    ]);
    expect(raced[0].count + Number(raced[1].data)).toBe(1);
    const racedRows = await prisma.trip.findMany({ where: { routeId: racedRoute.id, isDeleted: false } });
    expect(racedRows).toHaveLength(1);

    const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      await expect(
        other.trip.create({
          data: {
            id: newId(),
            routeId: racedRoute.id,
            driverId: captain.driver.id,
            status: TripStatus.Scheduled,
            scheduledAt: new Date(racedWhen),
            pricePerSeat: new Prisma.Decimal(20),
            availableSeats: 4,
            departureSlot: racedRows[0]?.departureSlot,
            ...baseFields(),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    } finally {
      await other.$disconnect();
    }

    await prisma.trip.update({
      where: { id: racedRows[0]!.id },
      data: { status: TripStatus.Cancelled },
    });
    const regenerated = await admin.generate(racedSchedule);
    expect(regenerated.data).toBe(1);
    expect(
      await prisma.trip.count({
        where: { routeId: racedRoute.id, isDeleted: false, status: { not: TripStatus.Cancelled } },
      }),
    ).toBe(1);

    const separate = await admin.generate({ ...schedule, routeId: otherRoute.id });
    expect(separate.data).toBe(1);
    const later = await admin.generate({
      ...schedule,
      routeId: route.id,
      startDate: '2026-12-12',
      endDate: '2026-12-12',
    });
    expect(later.data).toBe(1);
    expect(await prisma.trip.count({ where: { routeId: route.id, isDeleted: false } })).toBe(2);

    const platformFirst = await admin.generate({ ...schedule, routeId: platform.id });
    const platformSecond = await admin.generate({ ...schedule, routeId: platform.id });
    expect(platformFirst.data).toBe(1);
    expect(platformSecond.data).toBe(1);
    const platformRows = await prisma.trip.findMany({ where: { routeId: platform.id, isDeleted: false } });
    expect(platformRows).toHaveLength(2);
    expect(platformRows.every((trip) => trip.departureSlot == null)).toBe(true);

    const corridorRoute = await prisma.route.create({
      data: {
        id: newId(),
        name: 'Corridor line',
        startLatitude: 30,
        startLongitude: 31,
        endLatitude: 30.05,
        endLongitude: 31.05,
        isActive: true,
        ownerType: RouteOwnerType.Platform,
        ...baseFields(),
      },
    });
    await prisma.vehicle.createMany({
      data: [
        { id: newId(), plateNumber: `T-c1${Date.now().toString().slice(-4)}`, model: 'A', type: 1, capacity: 1, isActive: true, ...baseFields() },
        { id: newId(), plateNumber: `T-c2${Date.now().toString().slice(-4)}`, model: 'B', type: 1, capacity: 1, isActive: true, ...baseFields() },
      ],
    });
    await prisma.routeRequest.createMany({
      data: [rider, secondRider].map((user) => ({
        id: newId(),
        userId: user.id,
        fromAddress: 'Start',
        toAddress: 'End',
        fromLatitude: 30,
        fromLongitude: 31,
        toLatitude: 30.05,
        toLongitude: 31.05,
        status: 'pending',
        preferredVehicleType: 'carshuttle',
        ...baseFields(),
      })),
    });
    await prisma.vehicle.updateMany({
      where: { type: 1, capacity: { gt: 1 } },
      data: { isActive: false },
    });
    const corridor = new CorridorDemandService(db);
    let applied: { tripsCreated: number };
    try {
      applied = await corridor.apply(corridorRoute.id, {
        scheduledAt: '2026-12-15T06:30:00.000Z',
        pricePerSeat: 25,
      });
    } finally {
      await prisma.vehicle.updateMany({
        where: { id: captain.vehicle.id },
        data: { isActive: true },
      });
    }
    expect(applied.tripsCreated).toBe(2);
    const corridorRows = await prisma.trip.findMany({ where: { routeId: corridorRoute.id, isDeleted: false } });
    expect(corridorRows).toHaveLength(2);
    expect(corridorRows.every((trip) => trip.departureSlot == null)).toBe(true);
    expect(corridorRows[0]?.scheduledAt.toISOString()).toBe(corridorRows[1]?.scheduledAt.toISOString());

    const tripsBeforeGroup = await prisma.trip.count();
    const group = await prisma.groupRequest.create({
      data: {
        id: newId(),
        organizerUserId: rider.id,
        pickupLatitude: 30,
        pickupLongitude: 31,
        destinationLatitude: 30.1,
        destinationLongitude: 31.1,
        capacity: 4,
        joinedMemberCount: 1,
        status: GroupRequestStatus.Confirmed,
        paymentMethod: 'cash',
        isCashConfirmed: false,
        membershipLocked: false,
        ...money(),
        ...baseFields(),
      },
    });
    const groups = new AdminGroupsController(db, {
      publishGroup: async (id: string) => prisma.groupRequest.findUnique({ where: { id } }),
    } as unknown as GroupsService);
    await groups.assign(group.id, { driverId: captain.driver.id });
    expect(await prisma.trip.count()).toBe(tripsBeforeGroup);

    await prisma.tripSegmentInventory.deleteMany({
      where: { trip: { routeId: { in: [platform.id, corridorRoute.id] } } },
    });
    await prisma.trip.deleteMany({ where: { routeId: { in: [platform.id, corridorRoute.id] } } });
    await prisma.route.deleteMany({ where: { id: { in: [platform.id, corridorRoute.id] } } });
  });

  it('rolls back a failed transaction and leaves no partial user', async () => {
    const id = newId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: { id, phone: `0172${Date.now().toString().slice(-7)}`, userType: 1, ...userDefaults() },
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
  });

  it('assigns a group only through the admin controller', async () => {
    const organizer = await createUser(`0173${Date.now().toString().slice(-7)}`);
    const captain = await createCaptain(`0174${Date.now().toString().slice(-7)}`, true);
    createdUsers.push(organizer.id, captain.user.id);
    const group = await prisma.groupRequest.create({
      data: {
        id: newId(),
        organizerUserId: organizer.id,
        pickupLatitude: 30,
        pickupLongitude: 31,
        destinationLatitude: 30.1,
        destinationLongitude: 31.1,
        capacity: 4,
        joinedMemberCount: 1,
        status: GroupRequestStatus.Confirmed,
        paymentMethod: 'cash',
        isCashConfirmed: false,
        membershipLocked: false,
        ...money(),
        ...baseFields(),
      },
    });
    const admin = new AdminGroupsController(db, {
      publishGroup: async (id: string) => prisma.groupRequest.findUnique({ where: { id } }),
    } as unknown as GroupsService);
    await admin.assign(group.id, { driverId: captain.driver.id });
    const stored = await prisma.groupRequest.findUniqueOrThrow({ where: { id: group.id } });
    expect(stored.driverId).toBe(captain.driver.id);
    expect(stored.status).toBe(GroupRequestStatus.Assigned);
  });

  it('persists a support message and emits it on the support socket', async () => {
    const owner = await createUser(`0175${Date.now().toString().slice(-7)}`);
    createdUsers.push(owner.id);
    const ticket = await prisma.supportTicket.create({
      data: {
        id: newId(),
        userId: owner.id,
        subject: 'اختبار',
        status: 'open',
        ...baseFields(),
      },
    });
    const httpServer = createServer();
    const socketServer = new Server(httpServer, { path: '/hubs/support-chat' });
    const secret = 'integration-support-secret';
    const identity = new SocketIdentity(
      new JwtService({ secret }),
      {
        get: (key: string, fallback?: string) =>
          key === 'JWT_SECRET' ? secret : key === 'JWT_ISSUER' ? 'Shuttlez' : key === 'JWT_AUDIENCE' ? 'ShuttlezApp' : fallback,
        getOrThrow: (key: string) => {
          if (key === 'JWT_SECRET') return secret;
          throw new Error(`missing ${key}`);
        },
      } as unknown as ConfigService,
    );
    const gateway = new SupportChatGateway(identity, db);
    gateway.server = socketServer;
    socketServer.on('connection', (socket) => {
      socket.on('JoinTicket', (ticketId: unknown) => {
        void gateway.join(socket, ticketId);
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const token = new JwtService({ secret }).sign(
      { sub: owner.id },
      { issuer: 'Shuttlez', audience: 'ShuttlezApp', expiresIn: '5m' },
    );
    const socket: Socket = ioClient(`http://127.0.0.1:${port}`, {
      path: '/hubs/support-chat',
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('support socket timeout')), 4000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('support event timeout')), 4000);
        socket.once('SupportMessageCreated', (payload: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
      socket.emit('JoinTicket', ticket.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const controller = new SupportController(db, asUser(owner.id), gateway);
      await controller.send(ticket.id, { content: 'رسالة محفوظة' });
      const event = await received;
      const stored = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: ticket.id } });
      expect(stored.content).toBe('رسالة محفوظة');
      expect(stored.isFromSupport).toBe(false);
      expect(event).toMatchObject({
        id: stored.id,
        ticketId: ticket.id,
        content: 'رسالة محفوظة',
        isFromSupport: false,
      });
    } finally {
      socket.close();
      socketServer.close();
      httpServer.close();
    }
  });

  it('starts the Nest application against the isolated database', async () => {
    const target = new URL(databaseUrl);
    expect(target.hostname).toBe('127.0.0.1');
    expect(target.port).toBe('54329');
    expect(target.pathname).toBe('/shuttlez_integration_test');
    process.env.DATABASE_URL = databaseUrl;
    const app = await createNestApp();
    try {
      const prismaService = app.get(PrismaService);
      const identity = await prismaService.$queryRaw<Array<{ db: string; port: number }>>`
        SELECT current_database() AS db, inet_server_port() AS port`;
      expect(identity[0]?.db).toBe('shuttlez_integration_test');
      expect(Number(identity[0]?.port)).toBe(54329);
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: { status: 'healthy', service: 'Shuttlez.API' },
      });
    } finally {
      await app.close();
    }
  });
});
