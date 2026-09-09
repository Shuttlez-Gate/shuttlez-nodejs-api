import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { TripStatus, VehicleType } from '../../common/enums';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { haversineKm, refCode } from '../../common/utils/money';

const CORRIDOR_METERS = 100;
const MATCHABLE = ['pending', 'approved'];
const ESCALATION = ['carshuttle', 'minibus', 'bus'] as const;

type LatLng = { lat: number; lng: number };

type FleetVehicle = {
  vehicleId: string;
  plateNumber: string;
  model: string;
  capacity: number;
  driverId: string | null;
  driverName: string | null;
};

type FleetGroup = {
  vehicleType: string;
  vehicleCount: number;
  totalCapacity: number;
  vehicles: FleetVehicle[];
};

type SeatAssignment = {
  preferredVehicleType: string;
  seatsNeeded: number;
  seatsCovered: number;
  seatsShortfall: number;
  assignedVehicleType: string;
  vehiclesRequired: number;
  capacityPerVehicle: number;
  vehicleIds: string[];
  note: string | null;
};

type ProposedTrip = {
  vehicleType: string;
  vehicleId: string | null;
  vehiclePlate: string | null;
  driverId: string | null;
  driverName: string | null;
  availableSeats: number;
  suggestedPricePerSeat: number;
};

type MatchedRequest = {
  id: string;
  userId: string;
  userPhone: string;
  userName: string | null;
  fromAddress: string;
  toAddress: string;
  preferredVehicleType: string;
  weeklyCount: number;
  seats: number;
  fromDistanceMeters: number;
  toDistanceMeters: number;
  status: string;
};

@Injectable()
export class CorridorDemandService {
  constructor(private readonly prisma: PrismaService) {}

  async analyze(routeId: string) {
    const route = await this.prisma.route.findFirst({
      where: { id: routeId, isDeleted: false },
      include: { stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } } },
    });
    if (!route) {
      throw new NotFoundException('الخط غير موجود', ErrorCodes.RouteNotFound);
    }

    const polyline = buildPolyline(route);
    const hasPolyline = polyline.length >= 2;
    const requests = await this.prisma.routeRequest.findMany({
      where: { isDeleted: false, status: { in: MATCHABLE } },
      include: { user: true },
    });

    const matched: MatchedRequest[] = [];
    for (const req of requests) {
      if (!hasValidCoordinates(req.fromLatitude, req.fromLongitude) || !hasValidCoordinates(req.toLatitude, req.toLongitude)) {
        continue;
      }
      const origin = { lat: req.fromLatitude, lng: req.fromLongitude };
      const destination = { lat: req.toLatitude, lng: req.toLongitude };
      let fromDist: number;
      let toDist: number;
      let directionOk = true;
      if (hasPolyline) {
        const fromProx = distanceToPolyline(origin, polyline);
        const toProx = distanceToPolyline(destination, polyline);
        fromDist = fromProx.distanceMeters;
        toDist = toProx.distanceMeters;
        directionOk = fromProx.distanceAlongMeters <= toProx.distanceAlongMeters;
      } else {
        fromDist = haversineMeters(origin, { lat: route.startLatitude, lng: route.startLongitude });
        toDist = haversineMeters(destination, { lat: route.endLatitude, lng: route.endLongitude });
      }
      if (fromDist > CORRIDOR_METERS || toDist > CORRIDOR_METERS || !directionOk) {
        continue;
      }
      matched.push({
        id: req.id,
        userId: req.userId,
        userPhone: req.user.phone,
        userName: req.user.fullName,
        fromAddress: req.fromAddress,
        toAddress: req.toAddress,
        preferredVehicleType: normalizeVehicle(req.preferredVehicleType),
        weeklyCount: parseWeeklyCount(req.notes),
        seats: 1,
        fromDistanceMeters: Math.round(fromDist * 10) / 10,
        toDistanceMeters: Math.round(toDist * 10) / 10,
        status: req.status,
      });
    }

    const seatsByType: Record<string, number> = {};
    for (const row of matched) {
      seatsByType[row.preferredVehicleType] = (seatsByType[row.preferredVehicleType] ?? 0) + row.seats;
    }
    const fleet = await this.loadFleet();
    const assignment = distributeSeats(seatsByType, fleet);
    const proposedTrips = buildProposedTrips(assignment, fleet);

    return {
      routeId: route.id,
      routeName: route.name,
      corridorMeters: CORRIDOR_METERS,
      hasPolyline,
      matchedRequestsCount: matched.length,
      totalSeatsNeeded: matched.reduce((sum, row) => sum + row.seats, 0),
      seatsNeededByVehicleType: seatsByType,
      availableFleet: fleet,
      proposedAssignment: assignment,
      proposedTrips,
      matchedRequests: matched.sort((a, b) => a.fromDistanceMeters - b.fromDistanceMeters),
    };
  }

  async apply(routeId: string, body?: { scheduledAt?: string | null; pricePerSeat?: number | null }) {
    const report = await this.analyze(routeId);
    if (report.proposedTrips.length === 0) {
      throw new AppException(
        report.matchedRequestsCount === 0
          ? 'لا توجد طلبات مطابقة على مسار هذا الخط (±100م)'
          : 'لا توجد مركبات متاحة لتغطية الطلب',
        400,
      );
    }

    let scheduledAt = body?.scheduledAt ? new Date(body.scheduledAt) : tomorrowSevenUtc();
    if (Number.isNaN(scheduledAt.getTime())) {
      scheduledAt = tomorrowSevenUtc();
    }
    if (scheduledAt.getTime() <= Date.now()) {
      scheduledAt = new Date(Date.now() + 3 * 3_600_000);
    }
    const price = body?.pricePerSeat && body.pricePerSeat > 0 ? body.pricePerSeat : 100;
    const now = utcNow();

    const tripIds: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const proposal of report.proposedTrips) {
        const id = newId();
        await tx.trip.create({
          data: {
            id,
            routeId,
            driverId: proposal.driverId,
            status: proposal.driverId ? TripStatus.DriverAssigned : TripStatus.Scheduled,
            scheduledAt,
            pricePerSeat: new Prisma.Decimal(price),
            availableSeats: proposal.availableSeats,
            referenceCode: refCode('TRP'),
            ...baseFields(now),
          },
        });
        tripIds.push(id);
      }

      const requestIds = report.matchedRequests.map((r) => r.id);
      if (requestIds.length) {
        await tx.routeRequest.updateMany({
          where: { id: { in: requestIds } },
          data: { status: 'converted', updatedAt: now },
        });
        await tx.notification.createMany({
          data: report.matchedRequests.map((req) => ({
            id: newId(),
            userId: req.userId,
            title: 'خط السير أصبح متاحاً',
            body: `تم تشغيل خط قريب من طلبك (${req.fromAddress} ← ${req.toAddress}) ويمكن الحجز عليه.`,
            type: 'route_request',
            isRead: false,
            ...baseFields(now),
          })),
        });
      }
    });

    return {
      tripsCreated: tripIds.length,
      requestsConverted: report.matchedRequests.length,
      tripIds,
    };
  }

  private async loadFleet(): Promise<FleetGroup[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { isDeleted: false, isActive: true },
      include: {
        drivers: {
          where: { isDeleted: false, isActive: true },
          include: { user: true },
          take: 1,
        },
      },
    });
    const grouped = new Map<string, FleetVehicle[]>();
    for (const vehicle of vehicles) {
      const slug = vehicleSlug(vehicle.type);
      const driver = vehicle.drivers[0];
      const list = grouped.get(slug) ?? [];
      list.push({
        vehicleId: vehicle.id,
        plateNumber: vehicle.plateNumber,
        model: vehicle.model,
        capacity: vehicle.capacity,
        driverId: driver?.id ?? null,
        driverName: driver ? driver.user.fullName || driver.user.phone : null,
      });
      grouped.set(slug, list);
    }
    return [...grouped.entries()]
      .map(([vehicleType, items]) => ({
        vehicleType,
        vehicleCount: items.length,
        totalCapacity: items.reduce((sum, item) => sum + item.capacity, 0),
        vehicles: items.sort((a, b) => b.capacity - a.capacity),
      }))
      .sort((a, b) => a.vehicleType.localeCompare(b.vehicleType));
  }
}

function distributeSeats(seatsNeededByType: Record<string, number>, fleet: FleetGroup[]): SeatAssignment[] {
  const remaining = new Map(
    fleet.map((group) => [
      group.vehicleType,
      group.vehicles.map((v) => ({ ...v, remaining: v.capacity })),
    ]),
  );
  const result: SeatAssignment[] = [];

  for (const preferred of ESCALATION) {
    const needed = seatsNeededByType[preferred] ?? 0;
    if (needed <= 0) continue;
    let leftover = needed;
    let covered = 0;
    let assignedType: string = preferred;
    const usedVehicleIds: string[] = [];
    let capacityPerVehicle = 0;
    let note: string | null = null;

    for (const candidate of escalationPath(preferred)) {
      const pool = remaining.get(candidate);
      if (!pool?.length) continue;
      while (leftover > 0) {
        const slot = pool.filter((p) => p.remaining > 0).sort((a, b) => b.remaining - a.remaining)[0];
        if (!slot) break;
        const take = Math.min(leftover, slot.remaining);
        leftover -= take;
        covered += take;
        usedVehicleIds.push(slot.vehicleId);
        capacityPerVehicle = Math.max(capacityPerVehicle, slot.capacity);
        slot.remaining -= take;
        assignedType = candidate;
        if (candidate !== preferred) {
          note = `تم توجيه جزء من طلبات ${preferred} إلى ${candidate} لعدم كفاية الأسطول`;
        }
      }
      if (leftover <= 0) break;
    }

    result.push({
      preferredVehicleType: preferred,
      seatsNeeded: needed,
      seatsCovered: covered,
      seatsShortfall: leftover,
      assignedVehicleType: assignedType,
      vehiclesRequired: new Set(usedVehicleIds).size,
      capacityPerVehicle,
      vehicleIds: [...new Set(usedVehicleIds)],
      note: leftover > 0 ? (note ?? 'عجز في الأسطول — أضف مركبات أو خفّض الطلب') : note,
    });
  }

  for (const extra of Object.keys(seatsNeededByType)) {
    if (ESCALATION.includes(extra as (typeof ESCALATION)[number])) continue;
    const needed = seatsNeededByType[extra];
    result.push({
      preferredVehicleType: extra,
      seatsNeeded: needed,
      seatsCovered: 0,
      seatsShortfall: needed,
      assignedVehicleType: extra,
      vehiclesRequired: 0,
      capacityPerVehicle: 0,
      vehicleIds: [],
      note: 'نوع مركبة غير مدعوم',
    });
  }

  return result;
}

function buildProposedTrips(assignments: SeatAssignment[], fleet: FleetGroup[]): ProposedTrip[] {
  const lookup = new Map<string, { type: string; vehicle: FleetVehicle }>();
  for (const group of fleet) {
    for (const vehicle of group.vehicles) {
      lookup.set(vehicle.vehicleId, { type: group.vehicleType, vehicle });
    }
  }
  const trips: ProposedTrip[] = [];
  for (const assignment of assignments) {
    if (assignment.seatsCovered <= 0 || assignment.vehicleIds.length === 0) continue;
    let remainingSeats = assignment.seatsCovered;
    for (const vehicleId of assignment.vehicleIds) {
      const entry = lookup.get(vehicleId);
      if (!entry) continue;
      const seats = Math.min(remainingSeats, entry.vehicle.capacity);
      if (seats <= 0) continue;
      trips.push({
        vehicleType: entry.type,
        vehicleId: entry.vehicle.vehicleId,
        vehiclePlate: entry.vehicle.plateNumber,
        driverId: entry.vehicle.driverId,
        driverName: entry.vehicle.driverName,
        availableSeats: seats,
        suggestedPricePerSeat: 100,
      });
      remainingSeats -= seats;
      if (remainingSeats <= 0) break;
    }
  }
  return trips;
}

function escalationPath(preferred: string) {
  return [preferred, ...ESCALATION.filter((type) => type !== preferred)];
}

function vehicleSlug(type: number) {
  if (type === VehicleType.Bus) return 'bus';
  if (type === VehicleType.CarShuttle) return 'carshuttle';
  return 'minibus';
}

function normalizeVehicle(value?: string | null) {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'car':
    case 'carshuttle':
    case 'car_shuttle':
      return 'carshuttle';
    case 'bus':
      return 'bus';
    default:
      return 'minibus';
  }
}

function parseWeeklyCount(notes?: string | null) {
  if (!notes?.trim()) return 1;
  try {
    const root = JSON.parse(notes) as Record<string, unknown>;
    const raw = root.WeeklyCount ?? root.weeklyCount;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  } catch {
    return 1;
  }
}

function hasValidCoordinates(lat: number, lng: number) {
  return Math.abs(lat) > 0.01 || Math.abs(lng) > 0.01;
}

function tomorrowSevenUtc() {
  const now = utcNow();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 7, 0, 0));
}

function buildPolyline(route: {
  encodedPolyline: string | null;
  startLatitude: number;
  startLongitude: number;
  endLatitude: number;
  endLongitude: number;
  stops: Array<{ latitude: number; longitude: number }>;
}): LatLng[] {
  const decoded = decodePolyline(route.encodedPolyline);
  if (decoded.length >= 2) return decoded;
  return [
    { lat: route.startLatitude, lng: route.startLongitude },
    ...route.stops.map((s) => ({ lat: s.latitude, lng: s.longitude })),
    { lat: route.endLatitude, lng: route.endLongitude },
  ];
}

function decodePolyline(encoded?: string | null): LatLng[] {
  if (!encoded?.trim()) return [];
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    const latResult = nextPolylineValue(encoded, index);
    index = latResult.next;
    lat += latResult.value;
    if (index >= encoded.length) break;
    const lngResult = nextPolylineValue(encoded, index);
    index = lngResult.next;
    lng += lngResult.value;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

function nextPolylineValue(encoded: string, start: number) {
  let result = 0;
  let shift = 0;
  let index = start;
  let byte: number;
  do {
    byte = encoded.charCodeAt(index++) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20 && index < encoded.length);
  const value = result & 1 ? ~(result >> 1) : result >> 1;
  return { value, next: index };
}

function distanceToPolyline(point: LatLng, polyline: LatLng[]) {
  let best = Number.POSITIVE_INFINITY;
  let alongAtBest = 0;
  let travelled = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const closest = closestPointOnSegment(point, a, b);
    const dist = haversineMeters(point, closest.point);
    if (dist < best) {
      best = dist;
      alongAtBest = travelled + closest.alongMeters;
    }
    travelled += haversineMeters(a, b);
  }
  return { distanceMeters: best, distanceAlongMeters: alongAtBest };
}

function closestPointOnSegment(p: LatLng, a: LatLng, b: LatLng) {
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lng * lngScale;
  const ay = a.lat * latScale;
  const bx = b.lng * lngScale;
  const by = b.lat * latScale;
  const px = p.lng * lngScale;
  const py = p.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return {
    point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    alongMeters: haversineMeters(a, b) * t,
  };
}

function haversineMeters(a: LatLng, b: LatLng) {
  return haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
}
