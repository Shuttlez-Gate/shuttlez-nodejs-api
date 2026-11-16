import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  BookingStatus,
  DriverDocumentType,
  DriverVerificationStatus,
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import { money, platformCut } from '../../common/utils/money';
import { cairoDateKey } from '../bookings/rider-history-bucket';
import {
  driverDocumentMediaUrl,
  toDataUrlStoragePath,
} from '../../common/utils/document-storage';
import {
  captainVehicleKind,
  documentTypeLabel,
  groupStatusLabel,
  parseDocumentType,
  rideStatusLabel,
  tripStatusLabel,
  vehicleTypeLabel,
  verificationLabel,
} from '../../common/utils/enums-map';
import {
  decideRideAccept,
  estimateRideRemainingMinutes,
  evaluateOfferEligibility,
  NEAR_COMPLETION_MINUTES,
  offerVehicleCompatible,
  resolveOfferRadiusKm,
  workloadBlockReason,
} from './ride-offer-policy';
import { RidesService } from '../rides/rides.service';
import { FareService } from '../pricing/fare.service';
import {
  DriverGateway,
  RideTrackingGateway,
  TripTrackingGateway,
} from '../realtime/realtime.gateway';
import { GroupsService } from '../groups/groups.service';
import {
  publishRiderHistoryChange,
  publishTripRiders,
} from '../realtime/rider-history-signal';

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly rides: RidesService,
    private readonly groups: GroupsService,
    private readonly fare?: FareService,
    private readonly driverGateway?: DriverGateway,
    private readonly rideTrackingGateway?: RideTrackingGateway,
    private readonly tripTracking?: TripTrackingGateway,
  ) {}

  async me() {
    const driver = await this.requireDriver(false);
    return {
      id: driver.id,
      userId: driver.userId,
      phone: driver.user.phone,
      fullName: driver.user.fullName,
      email: driver.user.email,
      avatarUrl: driver.user.avatarUrl,
      isOnline: driver.isOnline,
      isActive: driver.isActive,
      verificationStatus: verificationLabel(driver.verificationStatus),
      ratingAverage: money(driver.ratingAverage),
      ratingCount: driver.ratingCount,
      vehicleId: driver.vehicleId,
      plateNumber: driver.plateNumber ?? driver.vehicle?.plateNumber,
      vehicleKind: driver.vehicleKind,
      vehicleModelName: driver.vehicleModelName ?? driver.vehicle?.model,
      seats: driver.seats ?? driver.vehicle?.capacity,
      documents: driver.documents
        .filter((d) => !d.isDeleted)
        .map((d) => ({
          id: d.id,
          documentType: documentTypeLabel(d.documentType),
          fileName: d.fileName,
          url: driverDocumentMediaUrl(d.id),
          createdAt: d.createdAt,
        })),
    };
  }

  async uploadDocument(
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
    documentType = 'Other',
    notes?: string,
  ) {
    const driver = await this.requireDriver(false);
    if (!file?.buffer?.length) {
      throw new AppException('الملف مطلوب');
    }
    const type = parseDocumentType(documentType);
    const doc = await this.prisma.driverDocument.create({
      data: {
        id: newId(),
        driverId: driver.id,
        documentType: type,
        fileName: file.originalname,
        contentType: file.mimetype || 'application/octet-stream',
        sizeBytes: BigInt(file.size),
        storagePath: toDataUrlStoragePath(file),
        notes: notes ?? null,
        uploadedBy: 'driver',
        ...baseFields(),
      },
    });
    if (type === DriverDocumentType.PersonalPhoto) {
      await this.prisma.user.update({
        where: { id: driver.userId },
        data: { avatarUrl: driverDocumentMediaUrl(doc.id), updatedAt: utcNow() },
      });
    }
    return {
      id: doc.id,
      documentType: documentTypeLabel(doc.documentType),
      fileName: doc.fileName,
      contentType: doc.contentType,
      sizeBytes: Number(doc.sizeBytes),
      url: driverDocumentMediaUrl(doc.id),
      uploadedBy: doc.uploadedBy,
      notes: doc.notes,
      createdAt: doc.createdAt,
    };
  }

  async myTrips() {
    const driver = await this.requireDriver();
    const now = utcNow();

    const plateNumber = driver.plateNumber ?? driver.vehicle?.plateNumber ?? null;
    const vehicleColor = driver.vehicleColor ?? null;

    // 1. جلب رحلات الشاتل المجدولة (Trips)
    const rows = await this.prisma.trip.findMany({
      where: { driverId: driver.id, isDeleted: false },
      include: {
        route: { include: { stops: { where: { isDeleted: false } } } },
        bookings: {
          where: { isDeleted: false },
          include: { user: { select: { fullName: true } } },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });
    const projectedTrips = rows.map((t) => {
      const confirmed = t.bookings.filter((b) => b.status === BookingStatus.Confirmed);
      const ui = resolveUiStatus(t.status, t.scheduledAt, now);
      const lastStop = [...t.route.stops].sort((a, b) => b.order - a.order)[0];
      const isCaptainRoute = t.route.ownerDriverId === driver.id;
      const collectedTotal = confirmed.reduce((sum, booking) => {
        const row =
          money(booking.totalAmount) > 0
            ? money(booking.totalAmount)
            : money(booking.pricePerSeat) * booking.seatCount;
        return sum + row;
      }, 0);
      const fareCollected = t.status === TripStatus.Completed && collectedTotal > 0;
      const cut = platformCut(fareCollected ? collectedTotal : 0);
      return {
        id: t.id,
        referenceCode: t.referenceCode,
        dateLabel: t.scheduledAt.toLocaleDateString('en-GB'),
        timeLabel: t.scheduledAt.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        vehicleType: isCaptainRoute
          ? 'CaptainRoute'
          : vehicleTypeLabel(driver.vehicle?.type ?? 1),
        from: t.route.name,
        to: lastStop?.name ?? t.route.description ?? 'الوصول',
        passengers: confirmed.reduce((s, b) => s + b.seatCount, 0),
        stations: t.route.stops.length,
        earnings: confirmed.reduce(
          (s, b) => s + (money(b.pricePerSeat) > 0 ? money(b.captainEarnings) : money(b.totalAmount)),
          0,
        ),
        status: ui,
        scheduledAt: t.scheduledAt,
        routeId: t.routeId,
        tripStatus: tripStatusLabel(t.status),
        pricePerSeat: money(t.pricePerSeat),
        availableSeats: t.availableSeats,
        kind: isCaptainRoute ? 'route' : 'shuttle',
        plateNumber: plateNumber,
        vehicleColor: vehicleColor,
        durationMinutes: t.route.durationSeconds
          ? Math.max(1, Math.round(t.route.durationSeconds / 60))
          : null,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        encodedPolyline: t.route.encodedPolyline,
        totalAmount: cut.total,
        appCommission: cut.appCommission,
        fareCollected,
        riders: confirmed.map((b) => ({
          id: b.id,
          userId: b.userId,
          name: b.user?.fullName?.trim() || 'راكب',
          seats: b.seatCount,
          fare:
            money(b.totalAmount) > 0
              ? money(b.totalAmount)
              : money(b.pricePerSeat) * b.seatCount,
          originStopId: b.originStopId,
          destinationStopId: b.destinationStopId,
        })),
        stopsList: [...t.route.stops]
          .sort((a, b) => a.order - b.order)
          .map((s) => ({
            id: s.id,
            name: s.name,
            order: s.order,
            latitude: s.latitude,
            longitude: s.longitude,
            boarding: confirmed
              .filter((b) => b.originStopId === s.id)
              .reduce((sum, b) => sum + b.seatCount, 0),
            alighting: confirmed
              .filter((b) => b.destinationStopId === s.id)
              .reduce((sum, b) => sum + b.seatCount, 0),
          })),
      };
    });

    // 2. جلب المشاوير اللحظية الخاصة بالكابتن (RideRequests)
    const rideRows = await this.prisma.rideRequest.findMany({
      where: { driverId: driver.id, isDeleted: false },
      include: { rider: true },
      orderBy: { createdAt: 'desc' },
    });
    const projectedRides = rideRows.map((r) => {
      const rideDate = r.scheduledFor ?? r.startedAt ?? r.assignedAt ?? r.createdAt;
      const live =
        r.status === RideRequestStatus.InProgress ||
        r.status === RideRequestStatus.Assigned;
      const uiStatus = resolveOpenUiStatus({
        cancelled: r.status === RideRequestStatus.Cancelled,
        completed: r.status === RideRequestStatus.Completed,
        live,
        appointment: rideDate,
        now,
      });
      const tripStatus =
        uiStatus === 'cancelled'
          ? 'Cancelled'
          : uiStatus === 'finished'
            ? 'Completed'
            : live
              ? 'InProgress'
              : 'Scheduled';

      const earnings =
        money(r.captainEarnings) > 0
          ? money(r.captainEarnings)
          : money(r.fareAmount || r.totalAmount);
      const rideTotal = money(r.totalAmount) || money(r.fareAmount);
      const fareCollected = r.status === RideRequestStatus.Completed && rideTotal > 0;
      const cut = platformCut(fareCollected ? rideTotal : 0);

      return {
        id: r.id,
        referenceCode: r.referenceCode,
        dateLabel: rideDate.toLocaleDateString('en-GB'),
        timeLabel: rideDate.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        vehicleType: r.requestedVehicleKind || vehicleTypeLabel(driver.vehicle?.type ?? 1),
        from: r.pickupAddress || 'نقطة الانطلاق',
        to: r.destinationAddress || 'الوجهة المحددة',
        passengers: 1,
        stations: 2,
        earnings,
        status: uiStatus,
        scheduledAt: rideDate,
        routeId: null,
        tripStatus,
        pricePerSeat: money(r.fareAmount || r.totalAmount),
        availableSeats: 0,
        kind: 'ride',
        plateNumber,
        vehicleColor,
        passengerName: r.rider?.fullName ?? null,
        totalAmount: cut.total,
        appCommission: cut.appCommission,
        fareCollected,
        distanceKm: r.distanceKm != null ? money(r.distanceKm) : null,
        durationMinutes:
          r.startedAt && r.completedAt
            ? Math.max(1, Math.round((r.completedAt.getTime() - r.startedAt.getTime()) / 60000))
            : null,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        stopsList: [
          {
            id: `${r.id}-pickup`,
            name: r.pickupAddress || 'نقطة الانطلاق',
            order: 0,
            latitude: r.pickupLatitude,
            longitude: r.pickupLongitude,
            boarding: 1,
            alighting: 0,
          },
          {
            id: `${r.id}-dropoff`,
            name: r.destinationAddress || 'الوجهة المحددة',
            order: 1,
            latitude: r.destinationLatitude,
            longitude: r.destinationLongitude,
            boarding: 0,
            alighting: 1,
          },
        ],
      };
    });

    // 3. جلب رحلات المجموعات الخاصة بالكابتن (GroupRequests)
    const groupRows = await this.prisma.groupRequest.findMany({
      where: { driverId: driver.id, isDeleted: false },
      include: { members: true },
      orderBy: { createdAt: 'desc' },
    });
    const projectedGroups = groupRows.map((g) => {
      const gDate = g.confirmedAt ?? g.startedAt ?? g.createdAt;
      const live =
        g.status === GroupRequestStatus.InProgress ||
        g.status === GroupRequestStatus.Assigned;
      const uiStatus = resolveOpenUiStatus({
        cancelled: g.status === GroupRequestStatus.Cancelled,
        completed: g.status === GroupRequestStatus.Completed,
        live,
        appointment: gDate,
        now,
      });
      const tripStatus =
        uiStatus === 'cancelled'
          ? 'Cancelled'
          : uiStatus === 'finished'
            ? 'Completed'
            : live
              ? 'InProgress'
              : 'Scheduled';

      const earnings =
        money(g.captainEarnings) > 0
          ? money(g.captainEarnings)
          : money(g.fareAmount || g.totalAmount);
      const groupTotal = money(g.totalAmount) || money(g.fareAmount);
      const fareCollected = g.status === GroupRequestStatus.Completed && groupTotal > 0;
      const cut = platformCut(fareCollected ? groupTotal : 0);

      return {
        id: g.id,
        referenceCode: g.referenceCode,
        dateLabel: gDate.toLocaleDateString('en-GB'),
        timeLabel: gDate.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        vehicleType: vehicleTypeLabel(driver.vehicle?.type ?? 1),
        from: g.pickupAddress || 'نقطة التجمع',
        to: g.destinationAddress || 'الوجهة المحددة',
        passengers: g.members?.length || 1,
        stations: 2,
        earnings,
        status: uiStatus,
        scheduledAt: gDate,
        routeId: null,
        tripStatus,
        pricePerSeat: money(g.fareAmount || g.totalAmount),
        availableSeats: 0,
        kind: 'group',
        plateNumber,
        vehicleColor,
        durationMinutes:
          g.startedAt && g.completedAt
            ? Math.max(1, Math.round((g.completedAt.getTime() - g.startedAt.getTime()) / 60000))
            : null,
        startedAt: g.startedAt,
        completedAt: g.completedAt,
        totalAmount: cut.total,
        appCommission: cut.appCommission,
        fareCollected,
        stopsList: [
          {
            id: `${g.id}-pickup`,
            name: g.pickupAddress || 'نقطة التجمع',
            order: 0,
            latitude: g.pickupLatitude,
            longitude: g.pickupLongitude,
            boarding: g.members?.length || 1,
            alighting: 0,
          },
          {
            id: `${g.id}-dropoff`,
            name: g.destinationAddress || 'الوجهة المحددة',
            order: 1,
            latitude: g.destinationLatitude,
            longitude: g.destinationLongitude,
            boarding: 0,
            alighting: g.members?.length || 1,
          },
        ],
      };
    });

    const allProjected = [...projectedTrips, ...projectedRides, ...projectedGroups];

    const current =
      allProjected.find((t) => t.status === 'active' || t.status === 'overdue') ?? null;
    const upcoming = allProjected
      .filter((t) => t.status === 'upcoming')
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
    const finished = allProjected
      .filter((t) => t.status === 'finished')
      .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());
    const cancelled = allProjected
      .filter((t) => t.status === 'cancelled')
      .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());

    return {
      current,
      upcoming,
      finished,
      cancelled,
      currentTrip: current,
      upcomingTrips: upcoming,
      historyTrips: [...finished, ...cancelled],
      cancelledTrips: cancelled,
    };
  }

  async startTrip(tripId: string) {
    return this.transitionTrip(tripId, true);
  }

  async completeTrip(tripId: string) {
    return this.transitionTrip(tripId, false);
  }

  async cancelTrip(tripId: string, reason?: string) {
    const driver = await this.requireDriver();
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, driverId: driver.id, isDeleted: false },
      include: {
        bookings: {
          where: {
            isDeleted: false,
            status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
          },
        },
      },
    });

    if (trip) {
      if (trip.status === TripStatus.Cancelled) {
        return { tripId: trip.id, status: 'Cancelled', message: 'الرحلة ملغية بالفعل' };
      }
      if (trip.status === TripStatus.Completed) {
        throw new AppException('لا يمكن إلغاء رحلة مكتملة', 400);
      }
      await this.prisma.trip.update({
        where: { id: trip.id },
        data: { status: TripStatus.Cancelled, updatedAt: utcNow() },
      });
      if (trip.bookings.length > 0) {
        await this.prisma.booking.updateMany({
          where: { tripId: trip.id, isDeleted: false },
          data: { status: BookingStatus.Cancelled, updatedAt: utcNow() },
        });
      }
      return { tripId: trip.id, status: 'Cancelled', message: 'تم إلغاء الرحلة بنجاح' };
    }

    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: tripId, driverId: driver.id, isDeleted: false },
    });
    if (ride) {
      return this.cancelRideByDriver(tripId, reason);
    }

    const group = await this.prisma.groupRequest.findFirst({
      where: { id: tripId, driverId: driver.id, isDeleted: false },
    });
    if (group) {
      await this.prisma.groupRequest.update({
        where: { id: group.id },
        data: { status: GroupRequestStatus.Cancelled, updatedAt: utcNow() },
      });
      return { tripId: group.id, status: 'Cancelled', message: 'تم إلغاء رحلة المجموعة بنجاح' };
    }

    throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
  }

  async publicProfile(driverId: string) {
    this.currentUser.requireUserId();
    if (!isUuid(driverId)) {
      throw new NotFoundException('الكابتن غير موجود');
    }
    const rows = await this.prisma.$queryRaw<ProfileRow[]>`
      SELECT
        d."Id" AS id,
        d."CreatedAt" AS "createdAt",
        d."VerificationStatus" AS "verificationStatus",
        d."VehicleKind" AS "vehicleKind",
        d."VehicleModelName" AS "vehicleModelName",
        d."VehicleColor" AS "vehicleColor",
        d."PlateNumber" AS "plateNumber",
        u."FullName" AS "fullName",
        u."AvatarUrl" AS "avatarUrl",
        v."Model" AS "vehicleModelFallback",
        v."PlateNumber" AS "plateFallback",
        (
          SELECT COUNT(*)::int FROM "TripsSet" t
          WHERE t."DriverId" = d."Id" AND t."IsDeleted" = false
            AND t."Status" = ${TripStatus.Completed}
        ) AS "completedTrips",
        (
          SELECT COUNT(*)::int FROM "RideRequestsSet" r
          WHERE r."DriverId" = d."Id" AND r."IsDeleted" = false
            AND r."Status" = ${RideRequestStatus.Completed}
        ) AS "completedRides",
        (
          SELECT COUNT(*)::int FROM "GroupRequestsSet" g
          WHERE g."DriverId" = d."Id" AND g."IsDeleted" = false
            AND g."Status" = ${GroupRequestStatus.Completed}
        ) AS "completedGroups",
        (
          SELECT COUNT(*)::int FROM "ReviewsSet" rv
          WHERE rv."DriverId" = d."Id" AND rv."IsDeleted" = false
        ) AS "ratingCount",
        (
          SELECT AVG(rv."Stars")::float FROM "ReviewsSet" rv
          WHERE rv."DriverId" = d."Id" AND rv."IsDeleted" = false
        ) AS "ratingAverage",
        (
          SELECT COALESCE(json_agg(item), '[]'::json) FROM (
            SELECT rv."Id" AS id, rv."Stars" AS stars, rv."Comment" AS comment,
                   rv."CreatedAt" AS "createdAt"
            FROM "ReviewsSet" rv
            WHERE rv."DriverId" = d."Id" AND rv."IsDeleted" = false
            ORDER BY rv."CreatedAt" DESC
            LIMIT 40
          ) item
        ) AS reviews
      FROM "DriversSet" d
      INNER JOIN "UsersSet" u ON u."Id" = d."UserId"
      LEFT JOIN "VehiclesSet" v ON v."Id" = d."VehicleId"
      WHERE d."Id" = CAST(${driverId} AS uuid) AND d."IsDeleted" = false
    `;
    const driver = rows[0];
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود');
    }
    const ratingCount = Number(driver.ratingCount ?? 0);
    const reviews = parseReviews(driver.reviews);
    return {
      id: driver.id,
      fullName: driver.fullName?.trim() || '',
      avatarUrl: driver.avatarUrl,
      verified: Number(driver.verificationStatus) === DriverVerificationStatus.Approved,
      ratingAverage: ratingCount > 0 ? money(driver.ratingAverage) : null,
      ratingCount,
      yearsOfService: fullYearsSince(new Date(driver.createdAt)),
      completedTrips:
        Number(driver.completedTrips ?? 0) +
        Number(driver.completedRides ?? 0) +
        Number(driver.completedGroups ?? 0),
      vehicleKind: driver.vehicleKind,
      vehicleModel: driver.vehicleModelName ?? driver.vehicleModelFallback ?? null,
      vehicleColor: driver.vehicleColor,
      plateNumber: driver.plateNumber ?? driver.plateFallback ?? null,
      reviews,
    };
  }

  async submitReview(
    driverId: string,
    body: { tripId?: string; stars?: number; comment?: string },
  ) {
    const userId = this.currentUser.requireUserId();
    const tripId = body.tripId?.trim() ?? '';
    const stars = Math.round(Number(body.stars));
    if (!isUuid(driverId)) {
      throw new NotFoundException('الكابتن غير موجود');
    }
    if (!isUuid(tripId) || stars < 1 || stars > 5) {
      throw new AppException('اختر عدد النجوم أولاً');
    }
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, isDeleted: false },
      select: { id: true, userId: true },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود');
    }
    if (driver.userId === userId) {
      throw new AppException('لا يمكن تقييم حسابك');
    }
    const comment = body.comment?.trim() || null;
    const summary = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.review.findFirst({
        where: { userId, tripId, isDeleted: false },
        select: { id: true, driverId: true },
      });
      if (existing) {
        await tx.review.update({
          where: { id: existing.id },
          data: { stars, comment, driverId: driver.id, updatedAt: utcNow() },
        });
      } else {
        await tx.review.create({
          data: {
            id: newId(),
            tripId,
            userId,
            driverId: driver.id,
            stars,
            comment,
            ...baseFields(),
          },
        });
      }
      const previousDriverId = existing?.driverId;
      if (previousDriverId && previousDriverId !== driver.id) {
        await refreshDriverRating(tx, previousDriverId);
      }
      const summary = await refreshDriverRating(tx, driver.id);
      return { ...summary, stars };
    });
    return summary;
  }

  async ratings() {
    const driver = await this.requireDriver();
    const reviews = await this.prisma.review.findMany({
      where: { driverId: driver.id, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
    return {
      average: money(driver.ratingAverage),
      count: driver.ratingCount,
      items: reviews.map((r) => ({
        id: r.id,
        stars: r.stars,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
    };
  }

  async myRides() {
    const driver = await this.requireDriver();
    const items = await this.prisma.rideRequest.findMany({
      where: { driverId: driver.id, isDeleted: false },
      include: { driver: { include: { user: true, vehicle: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((r) => this.rides.mapRide(r));
  }

  async pendingNearbyRides(latitude?: number, longitude?: number, radiusKm: number = 5) {
    const driver = await this.requireDriver();
    const workload = await this.loadOfferWorkload(driver, latitude, longitude);
    if (workload.block) return [];

    let evalLat = latitude;
    let evalLng = longitude;
    if (
      workload.activeRide?.status === RideRequestStatus.InProgress &&
      workload.remainingMinutes != null &&
      workload.remainingMinutes <= NEAR_COMPLETION_MINUTES &&
      workload.activeRide.destinationLatitude != null &&
      workload.activeRide.destinationLongitude != null
    ) {
      evalLat = workload.activeRide.destinationLatitude;
      evalLng = workload.activeRide.destinationLongitude;
    }
    if (evalLat == null || evalLng == null) return [];

    const maxRadiusKm = resolveOfferRadiusKm(radiusKm);

    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const items = await this.prisma.rideRequest.findMany({
      where: {
        status: RideRequestStatus.Requested,
        driverId: null,
        isDeleted: false,
        createdAt: { gte: cutoff },
      },
      include: {
        rider: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const captainKind = captainVehicleKind(driver);
    const results = [];
    for (const item of items) {
      const requestedKind = item.requestedVehicleKind ?? null;
      const decision = evaluateOfferEligibility({
        isActive: true,
        isOnline: true,
        hasActiveShuttle: false,
        hasActiveGroup: false,
        captainLatitude: evalLat,
        captainLongitude: evalLng,
        pickupLatitude: item.pickupLatitude,
        pickupLongitude: item.pickupLongitude,
        radiusKm: maxRadiusKm,
        requestedVehicleKind: requestedKind,
        captainVehicleKind: captainKind,
      });
      if (!decision.visible || decision.distanceKm == null) continue;

      const distanceToPickupKm = decision.distanceKm;
      const tripDist = item.distanceKm ? Number(item.distanceKm) : 3.0;
      this.driverGateway?.rememberOffer(item.id, driver.userId);
      results.push({
        id: item.id,
        vehicleKind: requestedKind || 'car',
        passengerName: item.rider?.fullName || 'راكب شاتلز',
        passengerPhone: item.rider?.phone || null,
        passengerRating:
          item.rider?.ratingAverage != null ? Number(item.rider.ratingAverage) : 4.9,
        passengerRatingCount: item.rider?.ratingCount ?? 0,
        passengerAvatarUrl: item.rider?.avatarUrl ?? null,
        referenceCode: item.referenceCode,
        pickupAddress: item.pickupAddress || 'نقطة الانطلاق',
        dropoffAddress: item.destinationAddress || 'الوجهة المحددة',
        pickupLatitude: item.pickupLatitude,
        pickupLongitude: item.pickupLongitude,
        destinationLatitude: item.destinationLatitude,
        destinationLongitude: item.destinationLongitude,
        fare: money(item.fareAmount),
        earnings: money(item.captainEarnings),
        distanceKm: money(distanceToPickupKm),
        tripDistanceKm: money(tripDist),
        etaMinutes: Math.max(3, Math.round(distanceToPickupKm * 2.5)),
        durationMinutes: Math.max(1, Math.round((tripDist / 30) * 60)),
        paymentMethod: item.paymentMethod || 'cash',
        timeoutSeconds: 30,
        createdAt: item.createdAt,
      });
    }

    // الشرط 4: ترتيب الرحلات الأقرب إلى الكابتن أولاً
    results.sort((a, b) => Number(a.distanceKm) - Number(b.distanceKm));
    return results.slice(0, 5);
  }

  async setAvailability(online: boolean) {
    const driver = await this.requireDriver();
    const updated = await this.prisma.driver.update({
      where: { id: driver.id },
      data: { isOnline: online, updatedAt: utcNow() },
    });
    return { driverId: driver.id, isOnline: updated.isOnline };
  }

  async acceptRide(rideId: string) {
    const driver = await this.requireDriver();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, isDeleted: false },
      include: { driver: { include: { user: true, vehicle: true } } },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    const decision = decideRideAccept({
      status: ride.status,
      rideDriverId: ride.driverId,
      actorDriverId: driver.id,
    });
    if (decision.action === 'reject') {
      throw new AppException(decision.message, decision.statusCode, decision.code);
    }
    if (decision.action === 'idempotent') {
      return this.acceptedRideResult(driver, ride, true);
    }

    await this.assertCanClaimRide(driver, ride);
    const claimed = await this.prisma.rideRequest.updateMany({
      where: {
        id: ride.id,
        isDeleted: false,
        status: RideRequestStatus.Requested,
        OR: [{ driverId: null }, { driverId: driver.id }],
      },
      data: {
        driverId: driver.id,
        status: RideRequestStatus.Assigned,
        assignedAt: utcNow(),
        updatedAt: utcNow(),
      },
    });
    const updated = await this.prisma.rideRequest.findFirst({
      where: { id: ride.id, isDeleted: false },
      include: { driver: { include: { user: true, vehicle: true } } },
    });
    if (!updated) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (claimed.count !== 1) {
      const again = decideRideAccept({
        status: updated.status,
        rideDriverId: updated.driverId,
        actorDriverId: driver.id,
      });
      if (again.action === 'idempotent') return this.acceptedRideResult(driver, updated, true);
      if (again.action === 'reject') {
        throw new AppException(again.message, again.statusCode, again.code);
      }
      throw new AppException('تم قبول هذا المشوار من قبل كابتن آخر', 400, ErrorCodes.RideNotAssignable);
    }

    this.driverGateway?.notifyClaimed(updated.id, driver.userId);
    publishRiderHistoryChange({
      userId: updated.riderUserId,
      product: 'ride',
      id: updated.id,
    });
    const presence = this.driverGateway?.getDriverPresence(driver.userId);
    const mappedRide = {
      ...this.rides.mapRide(updated, updated.requestedVehicleKind),
      ...(presence
        ? {
            captainLatitude: presence.latitude,
            captainLongitude: presence.longitude,
            captainLocationUpdatedAt: new Date(presence.updatedAt).toISOString(),
          }
        : {}),
    };
    this.rideTrackingGateway?.publishRideAccepted(mappedRide);
    return this.acceptedRideResult(driver, updated, false, mappedRide);
  }

  async rejectRide(rideId: string) {
    await this.requireDriver();
    return {
      rideId,
      rejected: true,
      message: 'تم تخطي المشوار',
    };
  }

  async startRide(rideId: string) {
    return this.transitionRide(rideId, true);
  }

  async completeRide(rideId: string) {
    return this.transitionRide(rideId, false);
  }

  async updateRideLocation(rideId: string, latitude: number, longitude: number) {
    const driver = await this.requireDriver();
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new AppException('إحداثيات غير صالحة', 400, ErrorCodes.RideLocationInvalid);
    }
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, driverId: driver.id, isDeleted: false },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (
      ride.status !== RideRequestStatus.Assigned &&
      ride.status !== RideRequestStatus.InProgress
    ) {
      throw new AppException(
        'لا يمكن تحديث الموقع في هذه الحالة',
        400,
        ErrorCodes.RideLocationNotAllowed,
      );
    }
    await this.prisma.rideRequest.update({
      where: { id: ride.id },
      data: { updatedAt: utcNow() },
    });
    this.rideTrackingGateway?.publishCaptainLocation(
      ride.id,
      {
        rideId: ride.id,
        latitude,
        longitude,
        timestamp: new Date().toISOString(),
      },
      ride.riderUserId,
    );
    return {
      rideId: ride.id,
      latitude,
      longitude,
      updatedAt: utcNow(),
      status: rideStatusLabel(ride.status),
    };
  }

  async confirmRideCash(rideId: string) {
    const driver = await this.requireDriver();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, driverId: driver.id, isDeleted: false },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    const amount = money(ride.totalAmount) || money(ride.fareAmount);
    this.rideTrackingGateway?.publishFareCollected(ride.id, amount, ride.riderUserId);
    return {
      rideId: ride.id,
      fareAmount: amount,
      collected: true,
    };
  }

  async myGroups() {
    const driver = await this.requireDriver();
    const items = await this.prisma.groupRequest.findMany({
      where: { driverId: driver.id, isDeleted: false },
      include: {
        driver: { include: { user: true } },
        members: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((g) => this.groups.mapGroup(g));
  }

  async startGroup(groupId: string) {
    return this.transitionGroup(groupId, true);
  }

  async completeGroup(groupId: string) {
    return this.transitionGroup(groupId, false);
  }

  private async transitionTrip(tripId: string, start: boolean) {
    const driver = await this.requireDriver();
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, driverId: driver.id, isDeleted: false },
    });
    if (!trip) {
      // تفقد ما إذا كان المعرّف خاصاً بمشوار لحظي أو رحلة مجموعة
      const ride = await this.prisma.rideRequest.findFirst({
        where: { id: tripId, driverId: driver.id, isDeleted: false },
      });
      if (ride) {
        return this.transitionRide(tripId, start);
      }
      const group = await this.prisma.groupRequest.findFirst({
        where: { id: tripId, driverId: driver.id, isDeleted: false },
      });
      if (group) {
        return this.transitionGroup(tripId, start);
      }
      throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
    }
    if (start) {
      if (trip.status === TripStatus.InProgress) {
        return lifecycle('trip', trip.id, driver.id, trip.status, trip.startedAt, trip.completedAt, 'الرحلة قيد التنفيذ بالفعل', true);
      }
      if (trip.status !== TripStatus.Scheduled && trip.status !== TripStatus.DriverAssigned) {
        throw new AppException('لا يمكن بدء الرحلة', 400, ErrorCodes.TripNotStartable);
      }
      const updated = await this.prisma.trip.update({
        where: { id: trip.id },
        data: { status: TripStatus.InProgress, startedAt: utcNow(), updatedAt: utcNow() },
      });
      const riders = await this.prisma.booking.findMany({
        where: { tripId: updated.id, isDeleted: false, status: { not: BookingStatus.Cancelled } },
        select: { userId: true },
      });
      this.tripTracking?.publishTripStarted(
        updated.id,
        riders.map((booking) => booking.userId),
      );
      await publishTripRiders(this.prisma, updated.id);
      return lifecycle('trip', updated.id, driver.id, updated.status, updated.startedAt, updated.completedAt, 'تم بدء الرحلة');
    }
    if (trip.status === TripStatus.Completed) {
      return lifecycle('trip', trip.id, driver.id, trip.status, trip.startedAt, trip.completedAt, 'الرحلة مكتملة بالفعل', true);
    }
    if (trip.status !== TripStatus.InProgress) {
      throw new AppException('لا يمكن إنهاء الرحلة', 400, ErrorCodes.TripNotCompletable);
    }
    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: { status: TripStatus.Completed, completedAt: utcNow(), updatedAt: utcNow() },
    });
    await publishTripRiders(this.prisma, updated.id);
    return lifecycle('trip', updated.id, driver.id, updated.status, updated.startedAt, updated.completedAt, 'تم إنهاء الرحلة');
  }

  private async transitionRide(rideId: string, start: boolean) {
    const driver = await this.requireDriver();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, driverId: driver.id, isDeleted: false },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (start) {
      if (ride.status === RideRequestStatus.InProgress) {
        return {
          rideId: ride.id,
          driverId: driver.id,
          status: rideStatusLabel(ride.status),
          startedAt: ride.startedAt,
          completedAt: ride.completedAt,
          updatedAt: ride.updatedAt,
          message: 'المشوار قيد التنفيذ بالفعل',
          idempotent: true,
        };
      }
      if (ride.status !== RideRequestStatus.Assigned) {
        throw new AppException('لا يمكن بدء المشوار', 400, ErrorCodes.RideNotStartable);
      }
      const updated = await this.prisma.rideRequest.update({
        where: { id: ride.id },
        data: { status: RideRequestStatus.InProgress, startedAt: utcNow(), updatedAt: utcNow() },
      });
      this.rideTrackingGateway?.publishRideStarted(
        updated.id,
        updated.startedAt,
        updated.riderUserId,
      );
      this.tripTracking?.publishTripStarted(updated.id, [updated.riderUserId]);
      publishRiderHistoryChange({
        userId: updated.riderUserId,
        product: 'ride',
        id: updated.id,
      });
      return {
        rideId: updated.id,
        driverId: driver.id,
        status: rideStatusLabel(updated.status),
        startedAt: updated.startedAt,
        completedAt: updated.completedAt,
        updatedAt: updated.updatedAt,
        message: 'تم بدء المشوار',
        idempotent: false,
      };
    }
    if (ride.status === RideRequestStatus.Completed) {
      return {
        rideId: ride.id,
        driverId: driver.id,
        status: rideStatusLabel(ride.status),
        startedAt: ride.startedAt,
        completedAt: ride.completedAt,
        updatedAt: ride.updatedAt,
        message: 'المشوار مكتمل بالفعل',
        idempotent: true,
      };
    }
    if (
      ride.status !== RideRequestStatus.InProgress &&
      ride.status !== RideRequestStatus.Assigned
    ) {
      throw new AppException('لا يمكن إنهاء المشوار', 400, ErrorCodes.RideNotCompletable);
    }
    const updated = await this.prisma.rideRequest.update({
      where: { id: ride.id },
      data: { status: RideRequestStatus.Completed, completedAt: utcNow(), updatedAt: utcNow() },
    });
    this.rideTrackingGateway?.publishRideCompleted(
      updated.id,
      updated.completedAt,
      money(updated.totalAmount) || money(updated.fareAmount),
      updated.distanceKm ? Number(updated.distanceKm) : undefined,
      updated.riderUserId,
    );
    publishRiderHistoryChange({
      userId: updated.riderUserId,
      product: 'ride',
      id: updated.id,
    });
    await this.rides.closeAbandonedSearches(updated.riderUserId, updated.id);
    this.driverGateway?.releaseActiveRide(driver.userId);
    return {
      rideId: updated.id,
      driverId: driver.id,
      status: rideStatusLabel(updated.status),
      startedAt: updated.startedAt,
      completedAt: updated.completedAt,
      updatedAt: updated.updatedAt,
      message: 'تم إنهاء المشوار',
      idempotent: false,
    };
  }

  private async transitionGroup(groupId: string, start: boolean) {
    const driver = await this.requireDriver();
    const group = await this.prisma.groupRequest.findFirst({
      where: { id: groupId, driverId: driver.id, isDeleted: false },
    });
    if (!group) {
      throw new NotFoundException('المجموعة غير موجودة', ErrorCodes.GroupNotFound);
    }
    if (start) {
      if (group.status === GroupRequestStatus.InProgress) {
        return {
          groupId: group.id,
          driverId: driver.id,
          status: groupStatusLabel(group.status),
          startedAt: group.startedAt,
          completedAt: group.completedAt,
          updatedAt: group.updatedAt,
          message: 'المجموعة قيد التنفيذ بالفعل',
          idempotent: true,
        };
      }
      if (
        group.status !== GroupRequestStatus.Assigned &&
        group.status !== GroupRequestStatus.Confirmed
      ) {
        throw new AppException('لا يمكن بدء المجموعة', 400, ErrorCodes.GroupNotStartable);
      }
      const updated = await this.prisma.groupRequest.update({
        where: { id: group.id },
        data: { status: GroupRequestStatus.InProgress, startedAt: utcNow(), updatedAt: utcNow() },
      });
      const members = await this.prisma.groupMember.findMany({
        where: { groupRequestId: updated.id, isDeleted: false },
        select: { userId: true },
      });
      this.tripTracking?.publishTripStarted(
        updated.id,
        members.map((member) => member.userId),
      );
      await this.groups.publishGroup(updated.id);
      return {
        groupId: updated.id,
        driverId: driver.id,
        status: groupStatusLabel(updated.status),
        startedAt: updated.startedAt,
        completedAt: updated.completedAt,
        updatedAt: updated.updatedAt,
        message: 'تم بدء المجموعة',
        idempotent: false,
      };
    }
    if (group.status === GroupRequestStatus.Completed) {
      return {
        groupId: group.id,
        driverId: driver.id,
        status: groupStatusLabel(group.status),
        startedAt: group.startedAt,
        completedAt: group.completedAt,
        updatedAt: group.updatedAt,
        message: 'المجموعة مكتملة بالفعل',
        idempotent: true,
      };
    }
    if (group.status !== GroupRequestStatus.InProgress) {
      throw new AppException('لا يمكن إنهاء المجموعة', 400, ErrorCodes.GroupNotCompletable);
    }
    const updated = await this.prisma.groupRequest.update({
      where: { id: group.id },
      data: { status: GroupRequestStatus.Completed, completedAt: utcNow(), updatedAt: utcNow() },
    });
    await this.groups.publishGroup(updated.id);
    return {
      groupId: updated.id,
      driverId: driver.id,
      status: groupStatusLabel(updated.status),
      startedAt: updated.startedAt,
      completedAt: updated.completedAt,
      updatedAt: updated.updatedAt,
      message: 'تم إنهاء المجموعة',
      idempotent: false,
    };
  }

  async arriveRide(rideId: string) {
    const driver = await this.requireDriver();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, driverId: driver.id, isDeleted: false },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (ride.status !== RideRequestStatus.Assigned) {
      throw new AppException('لا يمكن تأكيد الوصول إلا بعد قبول المشوار وقبل بدئه', 400);
    }
    await this.prisma.rideRequest.update({
      where: { id: ride.id },
      data: { updatedAt: utcNow() },
    });
    this.rideTrackingGateway?.publishArrivalConfirmed(ride.id);
    return {
      rideId: ride.id,
      arrived: true,
      message: 'تم تأكيد الوصول لنقطة الركوب بنجاح',
    };
  }

  async cancelRideByDriver(rideId: string, reason?: string) {
    const driver = await this.requireDriver();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, driverId: driver.id, isDeleted: false },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (ride.status === RideRequestStatus.Cancelled) {
      return { rideId: ride.id, cancelled: true, message: 'تم إلغاء المشوار بالفعل' };
    }
    if (ride.status === RideRequestStatus.Completed) {
      throw new AppException('لا يمكن إلغاء مشوار مكتمل', 400);
    }
    if (ride.status === RideRequestStatus.InProgress) {
      const stopped = await this.prisma.rideRequest.updateMany({
        where: {
          id: ride.id,
          driverId: driver.id,
          isDeleted: false,
          status: RideRequestStatus.InProgress,
        },
        data: {
          status: RideRequestStatus.Cancelled,
          cancelledAt: utcNow(),
          updatedAt: utcNow(),
        },
      });
      if (stopped.count !== 1) {
        const again = await this.prisma.rideRequest.findFirst({
          where: { id: ride.id, isDeleted: false },
        });
        if (again?.status === RideRequestStatus.Cancelled) {
          return { rideId: ride.id, cancelled: true, message: 'تم إلغاء المشوار بالفعل' };
        }
        throw new AppException('تعذر إلغاء المشوار', 400);
      }
      this.rideTrackingGateway?.publishRideCancelled(ride.id, 'driver', reason);
      this.driverGateway?.releaseActiveRide(driver.userId);
      publishRiderHistoryChange({
        userId: ride.riderUserId,
        product: 'ride',
        id: ride.id,
      });
      return { rideId: ride.id, cancelled: true, message: 'تم إلغاء المشوار' };
    }
    const released = await this.prisma.rideRequest.updateMany({
      where: {
        id: ride.id,
        driverId: driver.id,
        isDeleted: false,
        status: RideRequestStatus.Assigned,
      },
      data: {
        driverId: null,
        status: RideRequestStatus.Requested,
        assignedAt: null,
        updatedAt: utcNow(),
      },
    });
    if (released.count !== 1) {
      throw new AppException('لا يمكن إلغاء المشوار بعد بدئه، يمكن طلب إنهاء مبكر فقط', 400);
    }
    this.rideTrackingGateway?.publishRideCancelled(ride.id, 'driver', reason);
    if (ride.pickupLatitude != null && ride.pickupLongitude != null) {
      const rider = await this.prisma.user.findFirst({
        where: { id: ride.riderUserId },
        select: {
          fullName: true,
          phone: true,
          ratingAverage: true,
          ratingCount: true,
          avatarUrl: true,
        },
      });
      const releasedDistance = ride.distanceKm ? Number(ride.distanceKm) : 2.5;
      this.driverGateway?.broadcastNewRide({
        id: ride.id,
        vehicleKind: ride.requestedVehicleKind || 'car',
        passengerName: rider?.fullName || 'راكب شاتلز',
        passengerPhone: rider?.phone ?? null,
        passengerRating: rider ? Number(rider.ratingAverage) : 4.9,
        passengerRatingCount: rider?.ratingCount ?? 0,
        passengerAvatarUrl: rider?.avatarUrl ?? null,
        referenceCode: ride.referenceCode,
        pickupAddress: ride.pickupAddress || 'نقطة الانطلاق',
        dropoffAddress: ride.destinationAddress || 'الوجهة المحددة',
        pickupLatitude: ride.pickupLatitude,
        pickupLongitude: ride.pickupLongitude,
        destinationLatitude: ride.destinationLatitude,
        destinationLongitude: ride.destinationLongitude,
        fare: money(ride.fareAmount),
        earnings: money(ride.captainEarnings),
        distanceKm: ride.distanceKm ? money(ride.distanceKm) : 2.5,
        tripDistanceKm: money(releasedDistance),
        durationMinutes: Math.max(1, Math.round((releasedDistance / 30) * 60)),
        etaMinutes: Math.max(3, Math.round(releasedDistance * 2.5)),
        paymentMethod: ride.paymentMethod || 'cash',
        createdAt: ride.createdAt,
      });
    }
    return {
      rideId: ride.id,
      cancelled: true,
      message: 'تم إلغاء قبول المشوار وإعادة طرحه للكباتن',
    };
  }

  async handleEarlyTermination(
    rideId: string,
    action: 'request' | 'accept' | 'reject',
    initiator: 'driver' | 'rider',
    reason?: string,
    latitude?: number,
    longitude?: number,
  ) {
    const driver = await this.requireDriver();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, isDeleted: false },
    });
    if (!ride) throw new NotFoundException('المشوار غير موجود');
    if (ride.driverId !== driver.id) {
      throw new AppException('غير مصرح', 403, ErrorCodes.RideNotAssigned);
    }
    if (ride.status !== RideRequestStatus.InProgress) {
      throw new AppException('لا يمكن طلب إنهاء مبكر إلا لمشوار قيد التنفيذ', 400);
    }
    if (action === 'request') {
      this.rideTrackingGateway?.publishTerminationRequested(
        rideId,
        initiator,
        reason || 'ظرف طارئ',
        latitude,
        longitude,
      );
      return { rideId, requested: true, message: 'تم إرسال طلب الإنهاء المبكر' };
    }
    if (action === 'accept') {
      const updated = await this.prisma.rideRequest.update({
        where: { id: ride.id },
        data: {
          status: RideRequestStatus.Completed,
          completedAt: utcNow(),
          updatedAt: utcNow(),
        },
      });
      this.rideTrackingGateway?.publishTerminationResolved(rideId, true);
      this.rideTrackingGateway?.publishRideCompleted(
        updated.id,
        updated.completedAt,
        money(updated.totalAmount) || money(updated.fareAmount),
        updated.distanceKm ? Number(updated.distanceKm) : undefined,
        updated.riderUserId,
      );
      await this.rides.closeAbandonedSearches(updated.riderUserId, updated.id);
      return { rideId, resolved: true, completed: true, message: 'تم قبول الإنهاء المبكر واكتمال المشوار' };
    }
    this.rideTrackingGateway?.publishTerminationResolved(rideId, false);
    return { rideId, resolved: true, completed: false, message: 'تم رفض طلب الإنهاء المبكر' };
  }

  private acceptedRideResult(
    driver: { id: string },
    ride: {
      id: string;
      status: number;
      assignedAt: Date | null;
      requestedVehicleKind?: string | null;
      driver?: { user?: unknown; vehicle?: unknown } | null;
    },
    idempotent: boolean,
    mappedRide?: object,
  ) {
    const rideView = mappedRide ?? this.rides.mapRide(ride as never, ride.requestedVehicleKind ?? null);
    return {
      rideId: ride.id,
      driverId: driver.id,
      status: rideStatusLabel(ride.status),
      assignedAt: ride.assignedAt,
      message: 'تم قبول المشوار بنجاح',
      idempotent,
      ride: rideView,
    };
  }

  private async loadOfferWorkload(
    driver: { id: string; isActive: boolean; isOnline: boolean },
    latitude?: number,
    longitude?: number,
  ) {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const [activeTrip, activeGroup, activeRide] = await Promise.all([
      this.prisma.trip.findFirst({
        where: {
          driverId: driver.id,
          status: TripStatus.InProgress,
          isDeleted: false,
          OR: [
            { startedAt: { gte: twelveHoursAgo } },
            { startedAt: null, scheduledAt: { gte: twelveHoursAgo } },
          ],
        },
      }),
      this.prisma.groupRequest.findFirst({
        where: {
          driverId: driver.id,
          status: GroupRequestStatus.InProgress,
          isDeleted: false,
          createdAt: { gte: twelveHoursAgo },
        },
      }),
      this.prisma.rideRequest.findFirst({
        where: {
          driverId: driver.id,
          status: { in: [RideRequestStatus.Assigned, RideRequestStatus.InProgress] },
          isDeleted: false,
          createdAt: { gte: sixHoursAgo },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);
    const remainingMinutes =
      activeRide?.status === RideRequestStatus.InProgress
        ? estimateRideRemainingMinutes({
            captainLatitude: latitude,
            captainLongitude: longitude,
            destinationLatitude: activeRide.destinationLatitude,
            destinationLongitude: activeRide.destinationLongitude,
            startedAt: activeRide.startedAt,
            distanceKm: activeRide.distanceKm == null ? null : Number(activeRide.distanceKm),
            nowMs: Date.now(),
          })
        : null;
    return {
      activeTrip,
      activeGroup,
      activeRide,
      remainingMinutes,
      block: workloadBlockReason({
        isActive: driver.isActive,
        isOnline: driver.isOnline,
        hasActiveShuttle: Boolean(activeTrip),
        hasActiveGroup: Boolean(activeGroup),
        activeRideStatus: activeRide?.status ?? null,
        remainingMinutes,
      }),
    };
  }

  private async assertCanClaimRide(
    driver: {
      id: string;
      userId: string;
      isActive: boolean;
      isOnline: boolean;
      vehicleKind: string | null;
      vehicle: { type: number } | null;
    },
    ride: {
      pickupLatitude: number | null;
      pickupLongitude: number | null;
      requestedVehicleKind: string | null;
    },
  ) {
    const presence = this.driverGateway?.getDriverPresence(driver.userId);
    const workload = await this.loadOfferWorkload(
      driver,
      presence?.latitude,
      presence?.longitude,
    );
    if (workload.block === 'offline' || workload.block === 'inactive') {
      throw new AppException('الكابتن غير متاح لقبول المشوار', 403, ErrorCodes.DriverNotEligible);
    }
    if (workload.block === 'active_shuttle') {
      throw new AppException('الكابتن لديه رحلة شاتل جارية', 409, ErrorCodes.DriverTripConflict);
    }
    if (workload.block === 'active_group') {
      throw new AppException('الكابتن لديه رحلة مجموعة جارية', 409, ErrorCodes.DriverGroupConflict);
    }
    if (workload.block) {
      throw new AppException('الكابتن لديه مشوار آخر جارٍ', 409, ErrorCodes.DriverRideConflict);
    }
    const captainKind = captainVehicleKind(driver);
    if (!offerVehicleCompatible(ride.requestedVehicleKind, captainKind)) {
      throw new AppException('نوع مركبة الكابتن لا يطابق المشوار', 400, ErrorCodes.DriverNotEligible);
    }
    if (!presence) return;
    const decision = evaluateOfferEligibility({
      isActive: true,
      isOnline: true,
      hasActiveShuttle: false,
      hasActiveGroup: false,
      captainLatitude: presence.latitude,
      captainLongitude: presence.longitude,
      pickupLatitude: ride.pickupLatitude,
      pickupLongitude: ride.pickupLongitude,
      requestedVehicleKind: ride.requestedVehicleKind,
      captainVehicleKind: captainKind,
      locationUpdatedAtMs: presence.updatedAt,
      nowMs: Date.now(),
      enforceLocationFreshness: true,
    });
    if (decision.actionable) return;
    if (decision.reason === 'stale_location') {
      throw new AppException('موقع الكابتن غير محدث', 400, ErrorCodes.RideLocationInvalid);
    }
    if (decision.reason === 'pickup_too_far') {
      throw new AppException('نقطة الانطلاق خارج نطاق الكابتن', 400, ErrorCodes.DriverNotEligible);
    }
    throw new AppException('الكابتن غير مؤهل لقبول هذا المشوار', 400, ErrorCodes.DriverNotEligible);
  }

  private async requireDriver(mustBeActive = true) {
    const userId = this.currentUser.requireUserId();
    const driver = await this.prisma.driver.findFirst({
      where: { userId, isDeleted: false },
      include: {
        user: true,
        vehicle: true,
        documents: true,
      },
    });
    if (!driver) {
      throw new AppException('حساب الكابتن غير موجود', 404, ErrorCodes.DriverNotFound);
    }
    if (mustBeActive && !driver.isActive) {
      throw new AppException('حساب الكابتن غير موجود أو غير نشط', 403, ErrorCodes.DriverNotEligible);
    }
    return driver;
  }
}

type ProfileRow = {
  id: string;
  createdAt: Date | string;
  verificationStatus: number;
  vehicleKind: string | null;
  vehicleModelName: string | null;
  vehicleColor: string | null;
  plateNumber: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  vehicleModelFallback: string | null;
  plateFallback: string | null;
  completedTrips: number;
  completedRides: number;
  completedGroups: number;
  ratingCount: number;
  ratingAverage: number | null;
  reviews: unknown;
};

function parseReviews(value: unknown) {
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (JSON.parse(value) as unknown[])
      : [];
  return rows.map((row) => {
    const review = row as {
      id?: string;
      stars?: number;
      comment?: string | null;
      createdAt?: string;
    };
    return {
      id: review.id ?? '',
      stars: Number(review.stars ?? 0),
      comment: review.comment?.trim() || null,
      createdAt: review.createdAt ?? null,
    };
  });
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

async function refreshDriverRating(
  tx: Prisma.TransactionClient,
  driverId: string,
) {
  const aggregate = await tx.review.aggregate({
    where: { driverId, isDeleted: false },
    _avg: { stars: true },
    _count: { _all: true },
  });
  const ratingCount = aggregate._count._all;
  const ratingAverage = Number(aggregate._avg.stars ?? 0);
  await tx.driver.update({
    where: { id: driverId },
    data: { ratingAverage, ratingCount, updatedAt: utcNow() },
  });
  return { ratingAverage, ratingCount };
}

function fullYearsSince(from: Date, now = new Date()): number {
  let years = now.getUTCFullYear() - from.getUTCFullYear();
  const month = now.getUTCMonth() - from.getUTCMonth();
  if (month < 0 || (month === 0 && now.getUTCDate() < from.getUTCDate())) {
    years -= 1;
  }
  return Math.max(0, years);
}

function resolveUiStatus(status: number, scheduledAt: Date, now: Date): string {
  if (status === TripStatus.Cancelled) return 'cancelled';
  if (status === TripStatus.Completed) return 'finished';
  if (cairoDateKey(scheduledAt) < cairoDateKey(now)) return 'finished';
  if (status === TripStatus.InProgress) return 'active';
  if (scheduledAt.getTime() > now.getTime()) return 'upcoming';
  return 'overdue';
}

function resolveOpenUiStatus(input: {
  cancelled: boolean;
  completed: boolean;
  live: boolean;
  appointment: Date;
  now: Date;
}): 'active' | 'upcoming' | 'finished' | 'cancelled' {
  if (input.cancelled) return 'cancelled';
  if (input.completed) return 'finished';
  if (cairoDateKey(input.appointment) < cairoDateKey(input.now)) return 'finished';
  if (input.live) return 'active';
  return 'upcoming';
}

function lifecycle(
  _kind: string,
  id: string,
  driverId: string,
  status: number,
  startedAt: Date | null,
  completedAt: Date | null,
  message: string,
  idempotent = false,
) {
  return {
    tripId: id,
    driverId,
    status: tripStatusLabel(status),
    startedAt,
    completedAt,
    updatedAt: utcNow(),
    message,
    idempotent,
  };

}