import { Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  BookingStatus,
  PaymentStatus,
  RouteOwnerType,
  RoutePublishStatus,
  TripStatus,
} from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import { baseFields } from '../../common/utils/entity-defaults';
import { addDays, newId, utcNow } from '../../common/utils/date.util';
import {
  calculateTotal,
  money,
  refCode,
  requireCash,
  splitEarnings,
} from '../../common/utils/money';
import { bookingStatusLabel, invoiceStatusLabel } from '../../common/utils/enums-map';
import { FareService } from '../pricing/fare.service';
import { SegmentInventoryService } from '../marketplace/segment-inventory.service';
import { PushNotificationService } from '../marketplace/push-notification.service';
import {
  remainingForRange,
  segmentPrice,
} from '../marketplace/segment-occupancy';
import { loadRiderHistoryPage } from './rider-history-page';
import { publishRiderHistoryChange } from '../realtime/rider-history-signal';
import { riderHistoryBucket } from './rider-history-bucket';
import { isSelfOwnedTrip, tripsNotOwnedByViewer } from '../marketplace/self-booking';
import { matchPreviewStops } from '../marketplace/route-match';
import { PackageRideService } from '../subscriptions/package-ride.service';
import { lineLabels } from '../subscriptions/package-ride.policy';

@ApiTags('bookings')
@Controller('api/v1/bookings')
export class BookingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
    private readonly segments: SegmentInventoryService,
    private readonly push: PushNotificationService,
    private readonly packages?: PackageRideService,
  ) {}

  @Get('preview')
  async preview(
    @Query('sourceLatitude') sourceLatitude?: string,
    @Query('sourceLongitude') sourceLongitude?: string,
    @Query('destinationLatitude') destinationLatitude?: string,
    @Query('destinationLongitude') destinationLongitude?: string,
    @Query('sourceAddress') sourceAddress?: string,
    @Query('destinationAddress') destinationAddress?: string,
    @Query('vehicleTypeIndex') vehicleTypeIndex?: string,
  ) {
    const now = utcNow();
    const until = addDays(now, 7);
    const viewerId = this.currentUser.userId;
    const notOwn = viewerId ? tripsNotOwnedByViewer(viewerId) : {};

    const originLat = optionalCoord(sourceLatitude);
    const originLng = optionalCoord(sourceLongitude);
    const destLat = optionalCoord(destinationLatitude);
    const destLng = optionalCoord(destinationLongitude);
    const hasCoords =
      originLat != null && originLng != null && destLat != null && destLng != null;

    const viewerBookings = viewerId
      ? await this.prisma.booking.findMany({
          where: {
            userId: viewerId,
            isDeleted: false,
            status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
          },
          select: { tripId: true },
        })
      : [];
    const bookedTripIds = [...new Set(viewerBookings.map((booking) => booking.tripId))];
    const bookedSet = new Set(bookedTripIds);

    const platformTrips = await this.prisma.trip.findMany({
      where: {
        isDeleted: false,
        OR: [
          { availableSeats: { gt: 0 } },
          ...(bookedTripIds.length > 0 ? [{ id: { in: bookedTripIds } }] : []),
        ],
        status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
        scheduledAt: { gte: now, lte: until },
        route: {
          isDeleted: false,
          ownerType: RouteOwnerType.Platform,
        },
        ...notOwn,
      },
      include: {
        route: {
          include: {
            stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
          },
        },
        driver: { select: { vehicleKind: true, seats: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });

    const captainTrips = hasCoords
      ? await this.prisma.trip.findMany({
          where: {
            isDeleted: false,
            status: { in: [TripStatus.Scheduled, TripStatus.DriverAssigned] },
            scheduledAt: { gte: now, lte: until },
            route: {
              isDeleted: false,
              isActive: true,
              ownerType: RouteOwnerType.Captain,
              publishStatus: RoutePublishStatus.Published,
            },
            ...notOwn,
          },
          include: {
            route: {
              include: {
                stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
              },
            },
            driver: true,
            segmentInventories: { where: { isDeleted: false } },
          },
          orderBy: { scheduledAt: 'asc' },
          take: 80,
        })
      : [];

    type PreviewOffer = ReturnType<typeof platformOffer> & {
      originStopId?: string;
      destinationStopId?: string;
      sourceType?: string;
      scheduledAt: Date;
      vehicleKind?: string | null;
      captainRouteId?: string | null;
      vehicleBucket: 'carshuttle' | 'minibus' | 'bus' | 'scooter';
    };
    const offers: PreviewOffer[] = [];
    for (const trip of platformTrips) {
      const stops = trip.route.stops ?? [];
      if (hasCoords || sourceAddress || destinationAddress) {
        const match = matchPreviewStops(stops, {
          fromLatitude: originLat,
          fromLongitude: originLng,
          toLatitude: destLat,
          toLongitude: destLng,
          fromAddress: sourceAddress,
          toAddress: destinationAddress,
        });
        if (!match) {
          continue;
        }
        const firstOrder = stops[0]?.order ?? 0;
        const lastOrder = stops[stops.length - 1]?.order ?? firstOrder;
        offers.push({
          ...platformOffer(trip, match.origin.name, match.destination.name),
          pricePerSeat: segmentPrice(
            money(trip.pricePerSeat),
            match.origin.order,
            match.destination.order,
            firstOrder,
            lastOrder,
          ),
          originStopId: match.origin.id,
          destinationStopId: match.destination.id,
          vehicleKind: trip.route.vehicleKind ?? trip.driver?.vehicleKind ?? null,
          vehicleBucket: classifyVehicle(
            trip.route.vehicleKind ?? trip.driver?.vehicleKind,
            trip.route.capacity ?? trip.driver?.seats,
            trip.availableSeats,
          ),
        });
        continue;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      offers.push({
        ...platformOffer(
          trip,
          first?.name ?? sourceAddress,
          last && last.id !== first?.id ? last.name : destinationAddress,
        ),
        originStopId: first?.id,
        destinationStopId: last && last.id !== first?.id ? last.id : undefined,
        vehicleKind: trip.route.vehicleKind ?? null,
        vehicleBucket: classifyVehicle(
          trip.route.vehicleKind,
          trip.route.capacity,
          trip.availableSeats,
        ),
      });
    }

    if (hasCoords) {
      for (const trip of captainTrips) {
        const match = matchPreviewStops(trip.route.stops, {
          fromLatitude: originLat,
          fromLongitude: originLng,
          toLatitude: destLat,
          toLongitude: destLng,
          fromAddress: sourceAddress,
          toAddress: destinationAddress,
        });
        if (!match) {
          continue;
        }
        const remaining = remainingForRange(
          trip.segmentInventories,
          match.origin.order,
          match.destination.order,
        );
        const alreadyBooked = bookedSet.has(trip.id);
        if (remaining < 1 && !alreadyBooked) {
          continue;
        }
        const firstOrder = trip.route.stops[0]?.order ?? 0;
        const lastOrder = trip.route.stops[trip.route.stops.length - 1]?.order ?? firstOrder;
        const price = segmentPrice(
          money(trip.pricePerSeat),
          match.origin.order,
          match.destination.order,
          firstOrder,
          lastOrder,
        );
        offers.push({
          id: trip.id,
          pickupWalkLabel: '',
          pickupAddress: sourceAddress ?? match.origin.name,
          pickupTime: formatHm(trip.scheduledAt),
          dropoffAddress: destinationAddress ?? match.destination.name,
          dropoffTime: formatHm(
            new Date(
              trip.scheduledAt.getTime() +
                resolveDurationSeconds(trip.route.durationSeconds) * 1000,
            ),
          ),
          dropoffWalkLabel: '',
          plateLabel: trip.referenceCode ?? '',
          badgeVariant: 'captain',
          crossedPrice: '',
          packageLabel: '',
          packageLabelArgb: 0,
          seatsLabel: `${remaining} مقاعد`,
          seatsArgb: 0,
          seatsStrikethrough: false,
          cardDimmed: alreadyBooked,
          alreadyBooked,
          pricePerSeat: price,
          availableSeats: remaining,
          originStopId: match.origin.id,
          destinationStopId: match.destination.id,
          vehicleKind: trip.route.vehicleKind ?? trip.driver?.vehicleKind ?? null,
        captainRouteId: trip.routeId,
        vehicleBucket: classifyVehicle(
            trip.route.vehicleKind ?? trip.driver?.vehicleKind,
            trip.route.capacity ?? trip.driver?.seats,
            remaining,
          ),
          sourceType: 'captain',
          scheduledAt: trip.scheduledAt,
        });
      }
    }

    for (const offer of offers) {
      if (!bookedSet.has(offer.id)) continue;
      offer.alreadyBooked = true;
      offer.cardDimmed = true;
    }

    const requestedVehicle = previewVehicleBucket(vehicleTypeIndex);
    const bucketed = requestedVehicle
      ? offers.filter((offer) => offer.vehicleBucket === requestedVehicle)
      : offers;
    // The line matched the stations. Keep it selectable when the default
    // vehicle chip is a different bucket.
    const matchedOffers = bucketed.length > 0 ? bucketed : offers;
    // Calendar days from Cairo "today" forward (never past local days).
    const days = nextSevenCairoDays(now);
    const offersPerDay = days.map((day) =>
      matchedOffers
        .filter((offer) => sameCairoDay(offer.scheduledAt, day))
        .map(({ scheduledAt: _scheduledAt, vehicleBucket, ...offer }) => ({
          ...offer,
          vehicleKind: offer.vehicleKind || vehicleBucket,
        })),
    );

    const firstWithOffers = offersPerDay.findIndex((day) => day.length > 0);
    return ApiResponse.ok({
      sourceAddress: sourceAddress ?? '',
      destinationAddress: destinationAddress ?? '',
      dateChips: days.map((d, i) => ({
        dayName: weekdayNameAr(d),
        shortDate: ddMmUtc(d),
        isSelected: i === (firstWithOffers >= 0 ? firstWithOffers : 0),
      })),
      offersPerDay,
    });
  }

  @Post()
  @ApiBearerAuth()
  async create(
    @Body()
    body: {
      tripId: string;
      seatCount?: number;
      paymentMethod?: string;
      originStopId?: string;
      destinationStopId?: string;
      vehicleKind?: string;
      subscriptionId?: string;
    },
  ) {
    const userId = this.currentUser.requireUserId();
    const seatCount = body.seatCount ?? 1;
    if (seatCount < 1) {
      throw new AppException('عدد المقاعد غير صالح', 400, ErrorCodes.InvalidSeatCount);
    }
    const paymentMethod = requireCash(body.paymentMethod);
    const trip = await this.prisma.trip.findFirst({
      where: { id: body.tripId, isDeleted: false },
      include: {
        route: {
          include: {
            stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } },
            ownerDriver: { select: { userId: true } },
          },
        },
        driver: true,
      },
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
    }
    if (
      trip.status !== TripStatus.Scheduled &&
      trip.status !== TripStatus.DriverAssigned
    ) {
      throw new AppException('الرحلة غير متاحة للحجز', 400, ErrorCodes.TripNotBookable);
    }
    const existing = await this.prisma.booking.findFirst({
      where: {
        tripId: trip.id,
        userId,
        isDeleted: false,
        status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
      },
    });
    if (existing) {
      throw new AppException('لديك حجز على هذه الرحلة بالفعل', 400, ErrorCodes.DuplicateBooking);
    }
    if (
      isSelfOwnedTrip(
        userId,
        trip.route.ownerDriver?.userId,
        trip.driver?.userId,
      )
    ) {
      throw new AppException(
        'لا يمكنك حجز رحلتك',
        400,
        ErrorCodes.SelfBookingNotAllowed,
      );
    }
    if (await this.hasOverlappingBooking(userId, trip.id, trip.scheduledAt, trip.route.durationSeconds)) {
      throw new AppException(
        'لديك رحلة محجوزة في هذا الوقت',
        409,
        ErrorCodes.TripTimeConflict,
      );
    }

    const isCaptain = trip.route.ownerType === RouteOwnerType.Captain;
    const origin = body.originStopId
      ? trip.route.stops.find((s) => s.id === body.originStopId)
      : undefined;
    const destination = body.destinationStopId
      ? trip.route.stops.find((s) => s.id === body.destinationStopId)
      : undefined;
    if (isCaptain) {
      if (!origin || !destination || destination.order <= origin.order) {
        throw new AppException(
          'اختر محطة صعود ونزول صالحتين على المسار',
          400,
          ErrorCodes.InvalidStops,
        );
      }
    }

    const firstOrder = trip.route.stops[0]?.order ?? 0;
    const lastOrder =
      trip.route.stops[trip.route.stops.length - 1]?.order ?? firstOrder;
    const pricePerSeat = isCaptain && origin && destination
      ? segmentPrice(
          money(trip.pricePerSeat),
          origin.order,
          destination.order,
          firstOrder,
          lastOrder,
        )
      : money(trip.pricePerSeat);
    const totalAmount = calculateTotal(pricePerSeat, seatCount);
    const commissionPercent = await this.fare.platformCommissionPercent(trip.routeId);
    const split = splitEarnings(totalAmount, commissionPercent);
    const bookingId = newId();
    const referenceCode = refCode('BK');

    await this.prisma.$transaction(async (tx) => {
      if (paymentMethod === 'subscription') {
        const mode = this.packages
          ? await this.packages.reserveForBooking(tx, {
              userId,
              bookingId,
              routeId: trip.routeId,
              originOrder: origin?.order ?? null,
              destinationOrder: destination?.order ?? null,
              vehicleKind: body.vehicleKind ?? trip.route.vehicleKind ?? null,
              subscriptionId: body.subscriptionId,
              stopNames: [origin?.name, destination?.name, ...lineLabels(trip.route.name)].filter(
                (name): name is string => Boolean(name?.trim()),
              ),
            })
          : 'legacy';
        if (mode === 'legacy') await assertSubscriptionCredit(tx, userId);
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${trip.id}))`;
      const fresh = await tx.trip.findFirst({
        where: { id: trip.id, isDeleted: false },
        select: {
          driver: { select: { userId: true } },
          route: { select: { ownerDriver: { select: { userId: true } } } },
        },
      });
      if (
        fresh &&
        isSelfOwnedTrip(
          userId,
          fresh.route.ownerDriver?.userId,
          fresh.driver?.userId,
        )
      ) {
        throw new AppException(
          'لا يمكنك حجز رحلتك',
          400,
          ErrorCodes.SelfBookingNotAllowed,
        );
      }
      if (isCaptain && origin && destination) {
        await this.segments.tryDecrementRange(
          tx,
          trip.id,
          origin.order,
          destination.order,
          seatCount,
        );
        await this.segments.syncTripAvailableSeats(tx, trip.id);
      } else {
        const taken = await tx.$executeRaw`
          UPDATE "TripsSet"
          SET "AvailableSeats" = "AvailableSeats" - ${seatCount},
              "UpdatedAt" = NOW()
          WHERE "Id" = ${trip.id}::uuid
            AND "IsDeleted" = false
            AND "AvailableSeats" >= ${seatCount}
            AND "Status" IN (1, 2)`;
        if (Number(taken) === 0) {
          throw new AppException('لا توجد مقاعد كافية', 400, ErrorCodes.SeatUnavailable);
        }
      }
      await tx.booking.create({
        data: {
          id: bookingId,
          tripId: trip.id,
          userId,
          status: BookingStatus.Confirmed,
          seatCount,
          totalAmount: new Prisma.Decimal(totalAmount),
          paymentMethod,
          referenceCode,
          captainEarnings: new Prisma.Decimal(split.captainEarnings),
          commissionAmount: new Prisma.Decimal(split.commissionAmount),
          commissionRate: new Prisma.Decimal(split.commissionRate),
          pricePerSeat: new Prisma.Decimal(pricePerSeat),
          usesSubscriptionCredit: paymentMethod === 'subscription',
          originStopId: origin?.id ?? null,
          destinationStopId: destination?.id ?? null,
          vehicleKind:
            body.vehicleKind?.trim().slice(0, 40) ||
            trip.route.vehicleKind?.trim().slice(0, 40) ||
            trip.driver?.vehicleKind?.trim().slice(0, 40) ||
            null,
          ...baseFields(),
        },
      });
      await tx.invoice.create({
        data: {
          id: newId(),
          bookingId,
          amount: new Prisma.Decimal(totalAmount),
          status: PaymentStatus.Pending,
          ...baseFields(),
        },
      });
    });

    if (!isCaptain) {
      await this.prisma.markTripFullIfNeeded(trip.id);
    }
    if (trip.driver?.userId) {
      await this.push.notifyUser(
        trip.driver.userId,
        'حجز جديد',
        `تم تأكيد حجز ${seatCount} مقعد`,
        'booking_confirmed',
        { tripId: trip.id, bookingId },
      );
    }

    return ApiResponse.ok(
      {
        bookingId,
        tripId: trip.id,
        referenceCode,
        totalAmount,
        status: bookingStatusLabel(BookingStatus.Confirmed),
        message:
          paymentMethod === 'subscription'
            ? 'تم تأكيد الحجز من الباقة'
            : 'تم تأكيد الحجز — الدفع نقدًا للكابتن',
        pricePerSeat,
        seatCount,
        paymentMethod,
        originStopId: origin?.id ?? null,
        destinationStopId: destination?.id ?? null,
      },
      paymentMethod === 'subscription'
        ? 'تم تأكيد الحجز من الباقة'
        : 'تم تأكيد الحجز — الدفع نقدًا للكابتن',
    );
  }

  private async hasOverlappingBooking(
    userId: string,
    tripId: string,
    scheduledAt: Date,
    durationSeconds: number | null,
  ) {
    const start = scheduledAt.getTime();
    const end = start + (durationSeconds && durationSeconds > 0 ? durationSeconds : 3600) * 1000;
    const others = await this.prisma.booking.findMany({
      where: {
        userId,
        isDeleted: false,
        tripId: { not: tripId },
        status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
        trip: {
          isDeleted: false,
          status: {
            in: [TripStatus.Scheduled, TripStatus.DriverAssigned, TripStatus.InProgress],
          },
        },
      },
      select: {
        trip: {
          select: {
            scheduledAt: true,
            route: { select: { durationSeconds: true } },
          },
        },
      },
    });
    return others.some((booking) => {
      const otherStart = booking.trip.scheduledAt.getTime();
      const otherDuration = booking.trip.route.durationSeconds;
      const otherEnd =
        otherStart + (otherDuration && otherDuration > 0 ? otherDuration : 3600) * 1000;
      return start < otherEnd && otherStart < end;
    });
  }
}

@ApiTags('trips')
@Controller('api/v1/trips')
export class TripsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly segments: SegmentInventoryService,
    private readonly packageRides?: PackageRideService,
  ) {}

  @Get('history')
  async history(
    @Query('bucket') bucket?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('product') product?: string,
  ) {
    const userId = this.currentUser.requireUserId();
    const selected = bucket === 'past' ? 'past' : 'upcoming';
    return ApiResponse.ok(
      await loadRiderHistoryPage(this.prisma, userId, {
        bucket: selected,
        page: Number(page),
        pageSize: Number(pageSize),
        date,
        from,
        to,
        status,
        product,
      }),
    );
  }

  @Get('me')
  async me() {
    const userId = this.currentUser.requireUserId();
    const bookings = await this.prisma.booking.findMany({
      where: { userId, isDeleted: false },
      include: {
        originStop: true,
        destinationStop: true,
        trip: {
          include: {
            route: true,
            driver: {
              include: {
                user: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
        },
      },
      orderBy: [{ trip: { scheduledAt: 'desc' } }, { createdAt: 'desc' }],
    });
    const now = new Date();
    // JSON-safe DTOs (Prisma Decimal / null trip must not break history).
    const mapped = bookings
      .filter((b) => b.trip != null)
      .map((b) => ({
        id: b.id,
        tripId: b.tripId,
        status: b.status,
        seatCount: b.seatCount,
        referenceCode: b.referenceCode,
        vehicleKind: b.vehicleKind,
        totalAmount: money(b.totalAmount),
        createdAt: b.createdAt,
        originStop: b.originStop
          ? {
              id: b.originStop.id,
              name: b.originStop.name,
              latitude: b.originStop.latitude,
              longitude: b.originStop.longitude,
              order: b.originStop.order,
            }
          : null,
        destinationStop: b.destinationStop
          ? {
              id: b.destinationStop.id,
              name: b.destinationStop.name,
              latitude: b.destinationStop.latitude,
              longitude: b.destinationStop.longitude,
              order: b.destinationStop.order,
            }
          : null,
        trip: {
          id: b.trip.id,
          status: b.trip.status,
          scheduledAt: b.trip.scheduledAt,
          referenceCode: b.trip.referenceCode,
          availableSeats: b.trip.availableSeats,
          pricePerSeat: money(b.trip.pricePerSeat),
          route: b.trip.route
            ? {
                id: b.trip.route.id,
                name: b.trip.route.name,
                description: b.trip.route.description,
                capacity: b.trip.route.capacity,
                vehicleKind: b.trip.route.vehicleKind,
                ownerType: b.trip.route.ownerType,
                startLatitude: b.trip.route.startLatitude,
                startLongitude: b.trip.route.startLongitude,
                endLatitude: b.trip.route.endLatitude,
                endLongitude: b.trip.route.endLongitude,
                durationSeconds: b.trip.route.durationSeconds,
              }
            : null,
          driver: b.trip.driver
            ? {
                id: b.trip.driver.id,
                vehicleKind: b.trip.driver.vehicleKind,
                seats: b.trip.driver.seats,
                name: b.trip.driver.user?.fullName ?? null,
                photoUrl: b.trip.driver.user?.avatarUrl ?? null,
              }
            : null,
        },
      }));
    const buckets = mapped.map((booking) => ({
      booking,
      bucket: riderHistoryBucket({
        bookingStatus: booking.status,
        tripStatus: booking.trip.status,
        scheduledAt: new Date(booking.trip.scheduledAt),
        now,
      }),
    }));
    return ApiResponse.ok({
      upcoming: buckets
        .filter((row) => row.bucket === 'upcoming' || row.bucket === 'current')
        .map((row) => row.booking),
      past: buckets.filter((row) => row.bucket === 'past').map((row) => row.booking),
    });
  }

  @Get(':id')
  async details(@Param('id') id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, isDeleted: false },
      include: {
        route: { include: { stops: { where: { isDeleted: false } } } },
        bookings: { include: { originStop: true, destinationStop: true } },
        driver: {
          include: {
            user: { select: { fullName: true, avatarUrl: true } },
          },
        },
      },
    });
    if (!trip) {
      throw new NotFoundException('الرحلة غير موجودة');
    }
    return ApiResponse.ok(trip);
  }

  @Get(':id/invoice')
  async invoice(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    const booking = await this.prisma.booking.findFirst({
      where: { tripId: id, userId, isDeleted: false },
      include: { invoice: true, trip: true, user: true },
    });
    if (!booking?.invoice) {
      const ride = await this.prisma.rideRequest.findFirst({
        where: { id, riderUserId: userId, isDeleted: false },
        include: { rider: true },
      });
      if (!ride) {
        const member = await this.prisma.groupMember.findFirst({
          where: { groupRequestId: id, userId, isDeleted: false },
          include: { user: true, groupRequest: true },
        });
        const group = member?.groupRequest;
        if (!member || !group || group.isDeleted) {
          throw new NotFoundException('الفاتورة غير موجودة');
        }
        const amount = money(group.totalAmount);
        const seatFare = money(group.fareAmount);
        const when = group.confirmedAt ?? group.createdAt;
        const reference = group.referenceCode?.trim() || group.id.slice(0, 8);
        return ApiResponse.ok({
          bookingId: group.id,
          amount,
          status: 'cash',
          paidAt: null,
          tripId: reference.startsWith('#') ? reference : `#${reference}`,
          dateTimeLabel: `${when.toLocaleDateString('ar-EG', { weekday: 'long' })} ${formatDate(when)} - ${formatHm(when)} - نقدا`,
          passengerName: member.user.fullName?.trim() || '',
          lineItems: buildInvoiceLines({
            total: amount,
            baseFare: money(group.baseFareApplied ?? 0),
            distanceKm: money(group.distanceKm ?? 0),
            pricePerKm: money(group.pricePerKmApplied ?? 0),
            fareAmount: seatFare,
          }),
        });
      }
      const amount = money(ride.totalAmount);
      const seatFare = money(ride.fareAmount);
      const when = ride.scheduledFor ?? ride.createdAt;
      const reference = ride.referenceCode?.trim() || ride.id.slice(0, 8);
      return ApiResponse.ok({
        bookingId: ride.id,
        amount,
        status: 'cash',
        paidAt: null,
        tripId: reference.startsWith('#') ? reference : `#${reference}`,
        dateTimeLabel: `${when.toLocaleDateString('ar-EG', { weekday: 'long' })} ${formatDate(when)} - ${formatHm(when)} - نقدا`,
        passengerName: ride.rider.fullName?.trim() || '',
        lineItems: buildInvoiceLines({
          total: amount,
          baseFare: money(ride.baseFareApplied ?? 0),
          distanceKm: money(ride.distanceKm ?? 0),
          pricePerKm: money(ride.pricePerKmApplied ?? 0),
          fareAmount: seatFare,
        }),
      });
    }
    const amount = money(booking.invoice.amount);
    const seatFare = money(booking.pricePerSeat) * booking.seatCount;
    const lineItems = buildInvoiceLines({
      total: amount,
      baseFare: 0,
      distanceKm: 0,
      pricePerKm: 0,
      fareAmount: seatFare,
    });
    const when = booking.trip.scheduledAt;
    const reference = booking.referenceCode?.trim() || booking.id.slice(0, 8);
    return ApiResponse.ok({
      bookingId: booking.id,
      amount,
      status: invoiceStatusLabel(booking.invoice.status),
      paidAt: booking.invoice.paidAt,
      tripId: reference.startsWith('#') ? reference : `#${reference}`,
      dateTimeLabel: `${when.toLocaleDateString('ar-EG', { weekday: 'long' })} ${formatDate(when)} - ${formatHm(when)} - نقدا`,
      passengerName: booking.user.fullName?.trim() || '',
      lineItems,
    });
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    const booking = await this.prisma.booking.findFirst({
      where: { tripId: id, userId, isDeleted: false },
      include: { originStop: true, destinationStop: true },
    });
    if (!booking) {
      throw new NotFoundException('الحجز غير موجود');
    }
    if (booking.status === BookingStatus.Cancelled) {
      return ApiResponse.ok(true);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tripId}))`;
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.Cancelled, updatedAt: utcNow() },
      });
      if (this.packageRides) await this.packageRides.releaseBooking(tx, booking.id);
      if (booking.originStop && booking.destinationStop) {
        await this.segments.tryIncrementRange(
          tx,
          booking.tripId,
          booking.originStop.order,
          booking.destinationStop.order,
          booking.seatCount,
        );
        await this.segments.syncTripAvailableSeats(tx, booking.tripId);
      } else {
        await tx.$executeRaw`
          UPDATE "TripsSet"
          SET "AvailableSeats" = "AvailableSeats" + ${booking.seatCount},
              "UpdatedAt" = NOW()
          WHERE "Id" = ${booking.tripId}::uuid AND "IsDeleted" = false`;
      }
    });
    publishRiderHistoryChange({
      userId,
      product: 'trip',
      id: booking.tripId,
    });
    return ApiResponse.ok(true, 'تم إلغاء الرحلة بنجاح');
  }
}

@ApiTags('subscription-packages')
@Controller('api/v1/subscription-packages')
export class SubscriptionPackagesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly packageRides: PackageRideService,
  ) {}

  @Get()
  async packages() {
    const userId = this.currentUser.userId;
    const user = userId
      ? await this.prisma.user.findFirst({
          where: { id: userId, isDeleted: false },
          select: {
            id: true,
            activeSubscriptionPackageId: true,
            subscriptionExpiresAt: true,
            subscriptionActivatedAt: true,
          },
        })
      : null;
    const activeId = user?.activeSubscriptionPackageId ?? null;
    const usedTrips =
      user && activeId ? await this.prisma.booking.count({ where: subscriptionCreditWhere(user) }) : 0;
    const ledger = userId ? await this.packageRides.usageForUser(userId) : [];
    const items = await this.prisma.subscriptionPackage.findMany({
      where: { isActive: true, isDeleted: false },
      include: { route: { select: { id: true, name: true } } },
      orderBy: { price: 'asc' },
    });
    return ApiResponse.ok(
      items.map((p) => {
        const current = ledger.find((row) => row.packageId === p.id && row.isActive);
        const isCurrent = current != null || (activeId != null && p.id === activeId);
        const fields = this.packageRides.packageFields(p);
        return {
          id: p.id,
          name: p.name,
          title: p.name,
          description: p.description,
          price: money(p.price),
          tripCount: p.tripCount,
          validityDays: p.validityDays,
          isCurrent,
          ...fields,
          ...(isCurrent
            ? {
                usedTrips: current
                  ? current.ridesUsed + current.ridesReserved
                  : usedTrips,
                remainingTrips:
                  current?.remainingTrips ??
                  (p.tripCount > 0 ? Math.max(0, p.tripCount - usedTrips) : null),
                expiresAt: current?.expiresAt ?? user?.subscriptionExpiresAt ?? null,
                activatedAt: current?.activatedAt ?? user?.subscriptionActivatedAt ?? null,
              }
            : {}),
        };
      }),
    );
  }

  @Get('eligible')
  async eligible(
    @Query('tripId') tripId?: string,
    @Query('originStopId') originStopId?: string,
    @Query('destinationStopId') destinationStopId?: string,
  ) {
    const userId = this.currentUser.requireUserId();
    if (!tripId) throw new AppException('الرحلة مطلوبة', 400);
    return ApiResponse.ok(
      await this.packageRides.eligibleForTrip(userId, tripId, originStopId, destinationStopId),
    );
  }

  @Get('purchases')
  async purchases() {
    const userId = this.currentUser.requireUserId();
    return ApiResponse.ok(await this.packageRides.myPurchases(userId));
  }

  @Post('purchases/:id/submit')
  @UseInterceptors(
    FileInterceptor('screenshot', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async submitPurchase(
    @Param('id') id: string,
    @Body()
    body: {
      transactionReference?: string;
      transferredAt?: string;
      screenshotBase64?: string;
      screenshotMime?: string;
    },
    @UploadedFile() file?: { mimetype?: string; buffer: Buffer; size: number },
  ) {
    const userId = this.currentUser.requireUserId();
    const uploaded = file?.buffer?.length
      ? { mime: file.mimetype || 'application/octet-stream', bytes: file.buffer }
      : decodeScreenshot(body.screenshotBase64, body.screenshotMime);
    return ApiResponse.ok(
      await this.packageRides.submitPayment(userId, id, {
        transactionReference: body.transactionReference,
        transferredAt: body.transferredAt,
        screenshot: uploaded,
      }),
      'تم إرسال بيانات التحويل وبانتظار المراجعة',
    );
  }

  @Get('me')
  async mine() {
    const userId = this.currentUser.requireUserId();
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
    });
    if (!user?.activeSubscriptionPackageId) {
      return ApiResponse.ok(null);
    }
    const pkg = await this.prisma.subscriptionPackage.findFirst({
      where: { id: user.activeSubscriptionPackageId },
    });
    const where = subscriptionCreditWhere(user);
    const [usedTrips, bookings] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          originStop: { select: { name: true } },
          destinationStop: { select: { name: true } },
          trip: {
            select: {
              scheduledAt: true,
              status: true,
              route: {
                select: {
                  vehicleKind: true,
                  stops: {
                    where: { isDeleted: false },
                    orderBy: { order: 'asc' },
                    select: { name: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);
    const tripCount = pkg?.tripCount ?? 0;
    const expiresAt = user.subscriptionExpiresAt;
    const subscriptions = await this.packageRides.usageForUser(userId);
    const primary = subscriptions.find((row) => row.isActive) ?? subscriptions[0];
    return ApiResponse.ok({
      packageId: primary?.packageId ?? user.activeSubscriptionPackageId,
      packageName: primary?.packageName ?? pkg?.name ?? null,
      title: primary?.title ?? pkg?.name ?? '',
      tripCount: primary?.ridesTotal ?? tripCount,
      price: primary?.price ?? (pkg ? money(pkg.price) : 0),
      validityDays: primary?.validityDays ?? pkg?.validityDays ?? 30,
      expiresAt: primary?.expiresAt ?? expiresAt,
      activatedAt: primary?.activatedAt ?? user.subscriptionActivatedAt,
      isActive: primary ? primary.isActive : expiresAt == null || expiresAt.getTime() >= Date.now(),
      usedTrips: primary ? primary.ridesUsed + primary.ridesReserved : usedTrips,
      remainingTrips:
        primary?.remainingTrips ??
        (tripCount > 0 ? Math.max(0, tripCount - usedTrips) : null),
      routeName: primary?.routeName ?? null,
      direction: primary?.direction ?? null,
      subscriptions,
      bookings: mergePackageBookings(
        primary?.bookings,
        bookings.map((booking) => {
        const stops = booking.trip?.route?.stops ?? [];
        const tripStatus = booking.trip?.status;
        const status =
          tripStatus === TripStatus.Completed
            ? 'finished'
            : tripStatus === TripStatus.Cancelled
              ? 'cancelled'
              : 'upcoming';
        return {
          id: booking.id,
          referenceCode: booking.referenceCode ?? '',
          status,
          scheduledAt: booking.trip?.scheduledAt ?? booking.createdAt,
          from: booking.originStop?.name || stops[0]?.name || '',
          to:
            booking.destinationStop?.name ||
            stops[stops.length - 1]?.name ||
            '',
          vehicleKind:
            booking.vehicleKind || booking.trip?.route?.vehicleKind || '',
        };
      }),
      ),
    });
  }

  @Post(':id/subscribe')
  async subscribe(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    return ApiResponse.ok(
      await this.packageRides.createPurchase(userId, id),
      'تم إنشاء طلب الدفع. الباقة تتفعل بعد مراجعة التحويل.',
    );
  }
}

function decodeScreenshot(
  raw?: string,
  mime?: string,
): { mime: string; bytes: Buffer } | null {
  const value = raw?.trim();
  if (!value) return null;
  const data = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const declared = value.startsWith('data:')
    ? value.slice(5, value.indexOf(';'))
    : mime || 'image/jpeg';
  const bytes = Buffer.from(data, 'base64');
  return { mime: declared, bytes };
}

function mergePackageBookings<T extends { id: string }>(
  primary: T[] | undefined,
  legacy: T[],
): T[] {
  const seen = new Set((primary ?? []).map((row) => row.id));
  return [...(primary ?? []), ...legacy.filter((row) => !seen.has(row.id))];
}

function subscriptionCreditWhere(user: {
  id: string;
  subscriptionActivatedAt: Date | null;
}): Prisma.BookingWhereInput {
  return {
    userId: user.id,
    isDeleted: false,
    status: { in: [BookingStatus.Pending, BookingStatus.Confirmed] },
    OR: [
      { usesSubscriptionCredit: true },
      { paymentMethod: { in: ['subscription', 'package', 'باقة'] } },
    ],
    ...(user.subscriptionActivatedAt
      ? { createdAt: { gte: user.subscriptionActivatedAt } }
      : {}),
  };
}

async function assertSubscriptionCredit(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const user = await tx.user.findFirst({
    where: { id: userId, isDeleted: false },
    select: {
      id: true,
      activeSubscriptionPackageId: true,
      subscriptionExpiresAt: true,
      subscriptionActivatedAt: true,
    },
  });
  const expires = user?.subscriptionExpiresAt;
  if (
    !user?.activeSubscriptionPackageId ||
    (expires != null && expires.getTime() < Date.now())
  ) {
    throw new AppException(
      'انتهت صلاحية الباقة. برجاء التجديد أو الدفع نقدًا.',
      400,
      ErrorCodes.SubscriptionExpired,
    );
  }
  const pkg = await tx.subscriptionPackage.findFirst({
    where: { id: user.activeSubscriptionPackageId, isDeleted: false },
    select: { tripCount: true },
  });
  if (!pkg) {
    throw new AppException(
      'انتهت صلاحية الباقة. برجاء التجديد أو الدفع نقدًا.',
      400,
      ErrorCodes.SubscriptionExpired,
    );
  }
  if (pkg.tripCount <= 0) return;
  const used = await tx.booking.count({
    where: subscriptionCreditWhere(user),
  });
  if (used >= pkg.tripCount) {
    throw new AppException(
      'لقد استنفدت رحلات الباقة. اشترك في باقة جديدة أو ادفع نقدًا.',
      400,
      ErrorCodes.SubscriptionLimitReached,
    );
  }
}

function formatHm(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function buildInvoiceLines(input: {
  total: number;
  baseFare: number;
  distanceKm: number;
  pricePerKm: number;
  fareAmount: number;
}) {
  const lines: Array<{
    title: string;
    value: string;
    isTotal: boolean;
    highlight: boolean;
  }> = [];
  if (input.total > 0) {
    lines.push({
      title: 'المبلغ الاجمالي',
      value: formatMoney(input.total),
      isTotal: true,
      highlight: false,
    });
  }
  const base = input.baseFare > 0 ? input.baseFare : input.fareAmount;
  if (base > 0) {
    lines.push({
      title: 'رسوم الرحلة الأساسية',
      value: formatMoney(base),
      isTotal: false,
      highlight: false,
    });
  }
  if (input.distanceKm > 0 && input.pricePerKm > 0) {
    lines.push({
      title: 'تكلفة المسافة',
      value: formatMoney(
        Math.round(input.distanceKm * input.pricePerKm * 100) / 100,
      ),
      isTotal: false,
      highlight: false,
    });
  }
  return lines;
}

function previewVehicleBucket(
  raw?: string,
): 'carshuttle' | 'minibus' | 'bus' | 'scooter' | null {
  const value = raw?.trim().toLowerCase();
  if (value === '0' || value === 'car' || value === 'carshuttle') return 'carshuttle';
  if (value === '1' || value === 'minibus' || value === 'mini') return 'minibus';
  if (value === '2' || value === 'bus') return 'bus';
  if (value === '3' || value === '4' || value === 'scooter' || value === 'scooters' || value === 'سكوتر') {
    return 'scooter';
  }
  return null;
}

function classifyVehicle(
  kind?: string | null,
  capacity?: number | null,
  seatsHint?: number | null,
): 'carshuttle' | 'minibus' | 'bus' | 'scooter' {
  const text = (kind ?? '').trim().toLowerCase();
  if (text.includes('scooter') || text.includes('سكوتر')) {
    return 'scooter';
  }
  // Priority:
  // 1) Route.Capacity / Driver.Seats
  // 2) Route.VehicleKind / Driver.VehicleKind text
  // 3) available/remaining seats hint
  // Buckets: car 1-4, minibus 5-14, bus 15+.
  const seats =
    capacity != null && capacity > 0
      ? capacity
      : seatsHint != null && seatsHint > 0
        ? seatsHint
        : null;

  if (
    text.includes('mini') ||
    text.includes('ميني') ||
    text.includes('micro') ||
    text.includes('فان')
  ) {
    return 'minibus';
  }
  if (
    text.includes('bus') ||
    text.includes('coach') ||
    text.includes('باص') ||
    text.includes('اتوب') ||
    text.includes('أتوب')
  ) {
    return 'bus';
  }
  if (
    text.includes('carshuttle') ||
    text.includes('sedan') ||
    ((text.includes('car') || text.includes('سيار') || text.includes('عرب')) &&
      (seats == null || seats <= 4))
  ) {
    return 'carshuttle';
  }

  if (seats != null) {
    if (seats > 14) return 'bus';
    if (seats > 4) return 'minibus';
    return 'carshuttle';
  }

  return 'carshuttle';
}

const CAIRO_TZ = 'Africa/Cairo';

/** YYYY-MM-DD in Africa/Cairo. */
function cairoDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function sameCairoDay(a: Date, b: Date): boolean {
  return cairoDateKey(a) === cairoDateKey(b);
}

/**
 * Next 7 calendar days starting at Cairo local today.
 * Each entry is UTC noon on that Y-M-D so weekday/dd-MM stay stable.
 */
function nextSevenCairoDays(now: Date): Date[] {
  const [y, m, d] = cairoDateKey(now).split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function weekdayNameAr(dayUtcNoon: Date): string {
  return dayUtcNoon.toLocaleDateString('ar-EG', {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

function ddMmUtc(dayUtcNoon: Date): string {
  const dd = String(dayUtcNoon.getUTCDate()).padStart(2, '0');
  const mm = String(dayUtcNoon.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

function optionalCoord(raw?: string): number | null {
  if (raw == null || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function resolveDurationSeconds(durationSeconds: number | null | undefined): number {
  // Same default used by booking overlap checks when DurationSeconds is unset.
  return durationSeconds && durationSeconds > 0 ? durationSeconds : 3600;
}

function platformOffer(
  trip: {
    id: string;
    scheduledAt: Date;
    referenceCode: string | null;
    availableSeats: number;
    pricePerSeat: Prisma.Decimal;
    route: { name: string; description: string | null; durationSeconds: number | null };
  },
  sourceAddress?: string,
  destinationAddress?: string,
) {
  const durationMs = resolveDurationSeconds(trip.route.durationSeconds) * 1000;
  return {
    id: trip.id,
    pickupWalkLabel: '',
    pickupAddress: sourceAddress ?? trip.route.name,
    pickupTime: formatHm(trip.scheduledAt),
    dropoffAddress: destinationAddress ?? trip.route.description ?? trip.route.name,
    dropoffTime: formatHm(new Date(trip.scheduledAt.getTime() + durationMs)),
    dropoffWalkLabel: '',
    plateLabel: trip.referenceCode ?? '',
    badgeVariant: 'shuttle',
    crossedPrice: '',
    packageLabel: '',
    packageLabelArgb: 0,
    seatsLabel: `${trip.availableSeats} مقاعد`,
    seatsArgb: 0,
    seatsStrikethrough: false,
    cardDimmed: false,
    alreadyBooked: false,
    pricePerSeat: money(trip.pricePerSeat),
    availableSeats: trip.availableSeats,
    sourceType: 'platform',
    scheduledAt: trip.scheduledAt,
  };
}
