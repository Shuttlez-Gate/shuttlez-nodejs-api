import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  BookingStatus,
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import { money } from '../../common/utils/money';
import {
  documentTypeLabel,
  groupStatusLabel,
  parseDocumentType,
  rideStatusLabel,
  tripStatusLabel,
  vehicleTypeLabel,
  verificationLabel,
} from '../../common/utils/enums-map';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { RidesService } from '../rides/rides.service';
import { GroupsService } from '../groups/groups.service';

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly rides: RidesService,
    private readonly groups: GroupsService,
  ) {}

  async me() {
    const driver = await this.requireDriver();
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
          url: `/uploads/${d.storagePath}`,
          createdAt: d.createdAt,
        })),
    };
  }

  async uploadDocument(
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
    documentType = 'Other',
    notes?: string,
  ) {
    const driver = await this.requireDriver();
    if (!file?.buffer?.length) {
      throw new AppException('الملف مطلوب');
    }
    const dir = process.env.UPLOAD_DIR?.startsWith('/tmp')
      ? process.env.UPLOAD_DIR
      : join(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
    mkdirSync(dir, { recursive: true });
    const stored = `${driver.id}-${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`;
    writeFileSync(join(dir, stored), file.buffer);
    const doc = await this.prisma.driverDocument.create({
      data: {
        id: newId(),
        driverId: driver.id,
        documentType: parseDocumentType(documentType),
        fileName: file.originalname,
        contentType: file.mimetype || 'application/octet-stream',
        sizeBytes: BigInt(file.size),
        storagePath: stored,
        notes: notes ?? null,
        uploadedBy: 'driver',
        ...baseFields(),
      },
    });
    return {
      id: doc.id,
      documentType: documentTypeLabel(doc.documentType),
      fileName: doc.fileName,
      contentType: doc.contentType,
      sizeBytes: Number(doc.sizeBytes),
      url: `/uploads/${doc.storagePath}`,
      uploadedBy: doc.uploadedBy,
      notes: doc.notes,
      createdAt: doc.createdAt,
    };
  }

  async myTrips() {
    const driver = await this.requireDriver();
    const now = utcNow();
    const rows = await this.prisma.trip.findMany({
      where: { driverId: driver.id, isDeleted: false },
      include: {
        route: { include: { stops: { where: { isDeleted: false } } } },
        bookings: { where: { isDeleted: false } },
      },
      orderBy: { scheduledAt: 'asc' },
    });
    const projected = rows.map((t) => {
      const confirmed = t.bookings.filter((b) => b.status === BookingStatus.Confirmed);
      const ui = resolveUiStatus(t.status, t.scheduledAt, now);
      const lastStop = [...t.route.stops].sort((a, b) => b.order - a.order)[0];
      return {
        id: t.id,
        dateLabel: t.scheduledAt.toLocaleDateString('en-GB'),
        timeLabel: t.scheduledAt.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        vehicleType: vehicleTypeLabel(driver.vehicle?.type ?? 1),
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
      };
    });
    return {
      current:
        projected.find((t) => t.status === 'active' || t.status === 'overdue') ?? null,
      upcoming: projected.filter((t) => t.status === 'upcoming'),
      finished: projected.filter((t) => t.status === 'finished').reverse(),
    };
  }

  async startTrip(tripId: string) {
    return this.transitionTrip(tripId, true);
  }

  async completeTrip(tripId: string) {
    return this.transitionTrip(tripId, false);
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
    return {
      rideId: ride.id,
      latitude,
      longitude,
      updatedAt: utcNow(),
      status: rideStatusLabel(ride.status),
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
    if (ride.status !== RideRequestStatus.InProgress) {
      throw new AppException('لا يمكن إنهاء المشوار', 400, ErrorCodes.RideNotCompletable);
    }
    const updated = await this.prisma.rideRequest.update({
      where: { id: ride.id },
      data: { status: RideRequestStatus.Completed, completedAt: utcNow(), updatedAt: utcNow() },
    });
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

  private async requireDriver() {
    const userId = this.currentUser.requireUserId();
    const driver = await this.prisma.driver.findFirst({
      where: { userId, isDeleted: false },
      include: {
        user: true,
        vehicle: true,
        documents: true,
      },
    });
    if (!driver || !driver.isActive) {
      throw new AppException('حساب الكابتن غير موجود أو غير نشط', 403, ErrorCodes.DriverNotEligible);
    }
    return driver;
  }
}

function resolveUiStatus(status: number, scheduledAt: Date, now: Date): string {
  if (status === TripStatus.Completed || status === TripStatus.Cancelled) {
    return 'finished';
  }
  if (status === TripStatus.InProgress) {
    return 'active';
  }
  if (scheduledAt < now && status !== TripStatus.Completed) {
    return 'overdue';
  }
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
