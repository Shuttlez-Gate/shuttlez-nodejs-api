import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  BookingStatus,
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { money, platformCut } from '../../common/utils/money';
import { tripStatusLabel, vehicleTypeLabel } from '../../common/utils/enums-map';
import { cairoDateKey } from '../bookings/rider-history-bucket';
import { isPackageFunded } from '../subscriptions/package-ride.policy';

type StopRow = {
  id: string;
  name: string;
  order: number;
  latitude: number | null;
  longitude: number | null;
};

type BookingRow = {
  id: string;
  userId: string;
  seatCount: number;
  captainEarnings: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  pricePerSeat: Prisma.Decimal;
  paymentMethod: string;
  usesSubscriptionCredit: boolean;
  originStopId: string | null;
  destinationStopId: string | null;
  user: { fullName: string | null } | null;
};

function cairoDayBounds(now: Date): { start: Date; end: Date } {
  const key = cairoDateKey(now);
  const start = new Date(`${key}T00:00:00+02:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function uiFromTrip(status: number, scheduledAt: Date, now: Date): string {
  if (status === TripStatus.Cancelled) return 'cancelled';
  if (status === TripStatus.Completed) return 'finished';
  if (cairoDateKey(scheduledAt) < cairoDateKey(now)) return 'finished';
  if (status === TripStatus.InProgress) return 'active';
  if (scheduledAt.getTime() > now.getTime()) return 'upcoming';
  return 'overdue';
}

function stamp(when: Date) {
  return {
    dateLabel: when.toLocaleDateString('en-GB'),
    timeLabel: when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    scheduledAt: when,
  };
}

/** Open work plus today's completed rows. No route polyline and no history archive. */
export async function loadCaptainHomeBoard(
  prisma: PrismaService,
  driver: {
    id: string;
    plateNumber: string | null;
    vehicleColor: string | null;
    vehicle: { type: number; plateNumber: string | null } | null;
  },
) {
  const now = new Date();
  const day = cairoDayBounds(now);
  const plate = driver.plateNumber ?? driver.vehicle?.plateNumber ?? null;
  const color = driver.vehicleColor;
  const vehicleType = vehicleTypeLabel(driver.vehicle?.type ?? 1);
  const openTrip = {
    driverId: driver.id,
    isDeleted: false,
    OR: [
      { status: TripStatus.InProgress },
      {
        status: { notIn: [TripStatus.Completed, TripStatus.Cancelled] },
        scheduledAt: { gte: day.start },
      },
    ],
  };
  const doneTrip = {
    driverId: driver.id,
    isDeleted: false,
    status: TripStatus.Completed,
    OR: [
      { completedAt: { gte: day.start, lt: day.end } },
      { scheduledAt: { gte: day.start, lt: day.end } },
    ],
  };
  const tripSelect = {
    id: true,
    status: true,
    scheduledAt: true,
    startedAt: true,
    completedAt: true,
    pricePerSeat: true,
    availableSeats: true,
    referenceCode: true,
    routeId: true,
    route: {
      select: {
        name: true,
        description: true,
        ownerType: true,
        ownerDriverId: true,
        durationSeconds: true,
        stops: {
          where: { isDeleted: false },
          select: { id: true, name: true, order: true, latitude: true, longitude: true },
          orderBy: { order: 'asc' as const },
        },
      },
    },
    bookings: {
      where: { isDeleted: false, status: BookingStatus.Confirmed },
      select: {
        id: true,
        userId: true,
        seatCount: true,
        captainEarnings: true,
        totalAmount: true,
        pricePerSeat: true,
        paymentMethod: true,
        usesSubscriptionCredit: true,
        originStopId: true,
        destinationStopId: true,
        user: { select: { fullName: true } },
      },
    },
  } as const;

  const [openTrips, doneTrips, openRides, doneRides, openGroups, doneGroups] = await Promise.all([
    prisma.trip.findMany({ where: openTrip, select: tripSelect, orderBy: { scheduledAt: 'asc' }, take: 20 }),
    prisma.trip.findMany({ where: doneTrip, select: tripSelect, orderBy: { scheduledAt: 'desc' }, take: 20 }),
    prisma.rideRequest.findMany({
      where: {
        driverId: driver.id,
        isDeleted: false,
        status: { notIn: [RideRequestStatus.Completed, RideRequestStatus.Cancelled] },
      },
      include: { rider: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.rideRequest.findMany({
      where: {
        driverId: driver.id,
        isDeleted: false,
        status: RideRequestStatus.Completed,
        OR: [
          { completedAt: { gte: day.start, lt: day.end } },
          { createdAt: { gte: day.start, lt: day.end } },
        ],
      },
      include: { rider: { select: { fullName: true } } },
      take: 20,
    }),
    prisma.groupRequest.findMany({
      where: {
        driverId: driver.id,
        isDeleted: false,
        status: { notIn: [GroupRequestStatus.Completed, GroupRequestStatus.Cancelled] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.groupRequest.findMany({
      where: {
        driverId: driver.id,
        isDeleted: false,
        status: GroupRequestStatus.Completed,
        OR: [
          { completedAt: { gte: day.start, lt: day.end } },
          { createdAt: { gte: day.start, lt: day.end } },
        ],
      },
      take: 20,
    }),
  ]);

  const trips = [
    ...openTrips.map((trip) => mapTrip(trip, driver.id, plate, color, vehicleType, now)),
    ...doneTrips.map((trip) => mapTrip(trip, driver.id, plate, color, vehicleType, now)),
    ...openRides.map((ride) => mapRide(ride, plate, color, vehicleType, now)),
    ...doneRides.map((ride) => mapRide(ride, plate, color, vehicleType, now)),
    ...openGroups.map((group) => mapGroup(group, plate, color, now)),
    ...doneGroups.map((group) => mapGroup(group, plate, color, now)),
  ];
  return { trips };
}

function mapTrip(
  trip: {
    id: string;
    status: number;
    scheduledAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    pricePerSeat: Prisma.Decimal;
    availableSeats: number;
    referenceCode: string | null;
    routeId: string;
    route: {
      name: string;
      description: string | null;
      ownerType: number;
      ownerDriverId: string | null;
      durationSeconds: number | null;
      stops: StopRow[];
    };
    bookings: BookingRow[];
  },
  driverId: string,
  plate: string | null,
  color: string | null,
  vehicleType: string,
  now: Date,
) {
  const confirmed = trip.bookings;
  const cash = confirmed.filter(
    (booking) => !isPackageFunded(booking.paymentMethod, booking.usesSubscriptionCredit),
  );
  const collected = cash.reduce((sum, booking) => {
    const row = money(booking.totalAmount) > 0
      ? money(booking.totalAmount)
      : money(booking.pricePerSeat) * booking.seatCount;
    return sum + row;
  }, 0);
  const fareCollected = trip.status === TripStatus.Completed && collected > 0;
  const cut = platformCut(fareCollected ? collected : 0);
  const last = trip.route.stops[trip.route.stops.length - 1];
  const captainRoute = trip.route.ownerType === 1 && trip.route.ownerDriverId === driverId;
  return {
    id: trip.id,
    referenceCode: trip.referenceCode,
    ...stamp(trip.scheduledAt),
    vehicleType: captainRoute ? 'CaptainRoute' : vehicleType,
    from: trip.route.name,
    to: last?.name ?? trip.route.description ?? 'الوصول',
    passengers: confirmed.reduce((sum, booking) => sum + booking.seatCount, 0),
    stations: trip.route.stops.length,
    earnings: confirmed.reduce(
      (sum, booking) => sum + (money(booking.pricePerSeat) > 0 ? money(booking.captainEarnings) : money(booking.totalAmount)),
      0,
    ),
    status: uiFromTrip(trip.status, trip.scheduledAt, now),
    routeId: trip.routeId,
    tripStatus: tripStatusLabel(trip.status),
    pricePerSeat: money(trip.pricePerSeat),
    availableSeats: trip.availableSeats,
    kind: captainRoute ? 'route' : 'shuttle',
    plateNumber: plate,
    vehicleColor: color,
    durationMinutes: trip.route.durationSeconds
      ? Math.max(1, Math.round(trip.route.durationSeconds / 60))
      : null,
    startedAt: trip.startedAt,
    completedAt: trip.completedAt,
    totalAmount: cut.total,
    appCommission: cut.appCommission,
    fareCollected,
    riders: confirmed.map((booking) => ({
      id: booking.id,
      userId: booking.userId,
      name: booking.user?.fullName?.trim() || 'راكب',
      seats: booking.seatCount,
      fare: money(booking.totalAmount) > 0
        ? money(booking.totalAmount)
        : money(booking.pricePerSeat) * booking.seatCount,
      paymentMethod: booking.paymentMethod || 'cash',
      packageRide: isPackageFunded(booking.paymentMethod, booking.usesSubscriptionCredit),
    })),
    stopsList: trip.route.stops.map((stop) => ({
      id: stop.id,
      name: stop.name,
      order: stop.order,
      latitude: stop.latitude,
      longitude: stop.longitude,
      boarding: confirmed
        .filter((booking) => booking.originStopId === stop.id)
        .reduce((sum, booking) => sum + booking.seatCount, 0),
      alighting: confirmed
        .filter((booking) => booking.destinationStopId === stop.id)
        .reduce((sum, booking) => sum + booking.seatCount, 0),
    })),
  };
}

function mapRide(
  ride: {
    id: string;
    status: number;
    scheduledFor: Date | null;
    startedAt: Date | null;
    assignedAt: Date | null;
    createdAt: Date;
    completedAt: Date | null;
    captainEarnings: Prisma.Decimal;
    fareAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    requestedVehicleKind: string | null;
    pickupAddress: string | null;
    destinationAddress: string | null;
    pickupLatitude: number;
    pickupLongitude: number;
    destinationLatitude: number;
    destinationLongitude: number;
    referenceCode: string | null;
    rider: { fullName: string | null } | null;
  },
  plate: string | null,
  color: string | null,
  vehicleType: string,
  now: Date,
) {
  const when = ride.scheduledFor ?? ride.startedAt ?? ride.assignedAt ?? ride.createdAt;
  const live = ride.status === RideRequestStatus.InProgress || ride.status === RideRequestStatus.Assigned;
  const status = ride.status === RideRequestStatus.Cancelled
    ? 'cancelled'
    : ride.status === RideRequestStatus.Completed
      ? 'finished'
      : cairoDateKey(when) < cairoDateKey(now)
        ? 'finished'
        : live
          ? 'active'
          : 'upcoming';
  const earnings = money(ride.captainEarnings) > 0
    ? money(ride.captainEarnings)
    : money(ride.fareAmount || ride.totalAmount);
  const total = money(ride.totalAmount) || money(ride.fareAmount);
  const fareCollected = ride.status === RideRequestStatus.Completed && total > 0;
  const cut = platformCut(fareCollected ? total : 0);
  const name = ride.rider?.fullName?.trim() || 'راكب';
  return {
    id: ride.id,
    referenceCode: ride.referenceCode,
    ...stamp(when),
    vehicleType: ride.requestedVehicleKind || vehicleType,
    from: ride.pickupAddress || 'نقطة الانطلاق',
    to: ride.destinationAddress || 'الوجهة المحددة',
    passengers: 1,
    stations: 2,
    earnings,
    status,
    routeId: null,
    tripStatus: status === 'cancelled' ? 'Cancelled' : status === 'finished' ? 'Completed' : live ? 'InProgress' : 'Scheduled',
    pricePerSeat: money(ride.fareAmount || ride.totalAmount),
    availableSeats: 0,
    kind: 'ride',
    plateNumber: plate,
    vehicleColor: color,
    passengerName: name,
    totalAmount: cut.total,
    appCommission: cut.appCommission,
    fareCollected,
    startedAt: ride.startedAt,
    completedAt: ride.completedAt,
    riders: [{ id: ride.id, name, seats: 1 }],
    stopsList: [
      {
        id: `${ride.id}-pickup`,
        name: ride.pickupAddress || 'نقطة الانطلاق',
        order: 0,
        latitude: ride.pickupLatitude,
        longitude: ride.pickupLongitude,
        boarding: 1,
        alighting: 0,
      },
      {
        id: `${ride.id}-dropoff`,
        name: ride.destinationAddress || 'الوجهة المحددة',
        order: 1,
        latitude: ride.destinationLatitude,
        longitude: ride.destinationLongitude,
        boarding: 0,
        alighting: 1,
      },
    ],
  };
}

function mapGroup(
  group: {
    id: string;
    status: number;
    startedAt: Date | null;
    createdAt: Date;
    completedAt: Date | null;
    pickupAddress: string | null;
    destinationAddress: string | null;
    pickupLatitude: number;
    pickupLongitude: number;
    destinationLatitude: number;
    destinationLongitude: number;
    joinedMemberCount: number;
    fareAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    captainEarnings: Prisma.Decimal;
    referenceCode: string | null;
  },
  plate: string | null,
  color: string | null,
  now: Date,
) {
  const when = group.startedAt ?? group.createdAt;
  const live = group.status === GroupRequestStatus.InProgress || group.status === GroupRequestStatus.Assigned;
  const status = group.status === GroupRequestStatus.Cancelled
    ? 'cancelled'
    : group.status === GroupRequestStatus.Completed
      ? 'finished'
      : cairoDateKey(when) < cairoDateKey(now)
        ? 'finished'
        : live
          ? 'active'
          : 'upcoming';
  const total = money(group.totalAmount) || money(group.fareAmount);
  const fareCollected = group.status === GroupRequestStatus.Completed && total > 0;
  const cut = platformCut(fareCollected ? total : 0);
  return {
    id: group.id,
    referenceCode: group.referenceCode,
    ...stamp(when),
    vehicleType: 'car',
    from: group.pickupAddress || 'نقطة التجمع',
    to: group.destinationAddress || 'الوجهة المحددة',
    passengers: Math.max(group.joinedMemberCount, 1),
    stations: 2,
    earnings: money(group.captainEarnings) || money(group.fareAmount),
    status,
    routeId: null,
    kind: 'group',
    plateNumber: plate,
    vehicleColor: color,
    totalAmount: cut.total,
    appCommission: cut.appCommission,
    fareCollected,
    startedAt: group.startedAt,
    completedAt: group.completedAt,
    stopsList: [
      {
        id: `${group.id}-pickup`,
        name: group.pickupAddress || 'نقطة التجمع',
        order: 0,
        latitude: group.pickupLatitude,
        longitude: group.pickupLongitude,
        boarding: Math.max(group.joinedMemberCount, 1),
        alighting: 0,
      },
      {
        id: `${group.id}-dropoff`,
        name: group.destinationAddress || 'الوجهة المحددة',
        order: 1,
        latitude: group.destinationLatitude,
        longitude: group.destinationLongitude,
        boarding: 0,
        alighting: Math.max(group.joinedMemberCount, 1),
      },
    ],
  };
}
