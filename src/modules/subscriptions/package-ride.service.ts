import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { baseFields } from '../../common/utils/entity-defaults';
import { addDays, newId, utcNow } from '../../common/utils/date.util';
import { money, refCode } from '../../common/utils/money';
import { packagePaymentProvider } from './instapay-provider';
import {
  PurchaseStatus,
  ReservationStatus,
  SubscriptionStatus,
  applyFinalize,
  approvePurchase,
  isEligible,
  isPackageFunded,
  lineLabels,
  normalizeDirection,
  normalizeTransactionReference,
  pickSubscription,
  rejectPurchase,
  remainingRides,
  submitPurchaseStatus,
  tripDirection,
  validateScreenshot,
  type SubscriptionLedger,
} from './package-ride.policy';

type Db = PrismaService | Prisma.TransactionClient;

const ACTIVE_LIKE = [SubscriptionStatus.Active, SubscriptionStatus.Pending];

@Injectable()
export class PackageRideService {
  constructor(private readonly prisma: PrismaService) {}

  paymentDetails(amount: number, reference: string) {
    const provider = packagePaymentProvider();
    return {
      ...provider.instructions(),
      amount,
      currency: 'EGP',
      reference,
    };
  }

  async createPurchase(userId: string, packageId: string) {
    const pkg = await this.prisma.subscriptionPackage.findFirst({
      where: { id: packageId, isActive: true, isDeleted: false },
      include: { route: { select: { id: true, name: true } } },
    });
    if (!pkg) throw new NotFoundException('الباقة غير موجودة');
    if (!pkg.routeId) {
      throw new AppException('الباقة غير مربوطة بخط سير', 400, ErrorCodes.PackageNotEligible);
    }
    const amount = money(pkg.price);
    const reference = `${refCode('PKG')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const purchase = await this.prisma.packagePurchase.create({
      data: {
        id: newId(),
        userId,
        packageId: pkg.id,
        amount: new Prisma.Decimal(amount),
        currency: 'EGP',
        publicReference: reference,
        status: PurchaseStatus.PendingPayment,
        provider: 'manual_instapay',
        ...baseFields(),
      },
    });
    await this.audit(this.prisma, purchase.id, userId, 'CREATED', null);
    return {
      purchaseId: purchase.id,
      status: purchase.status,
      activated: false,
      amount,
      currency: 'EGP',
      reference,
      packageId: pkg.id,
      title: pkg.name,
      tripCount: pkg.tripCount,
      price: amount,
      validityDays: pkg.validityDays,
      routeId: pkg.routeId,
      routeName: pkg.route?.name ?? null,
      direction: normalizeDirection(pkg.direction),
      vehicleKind: pkg.vehicleKind,
      instapay: this.paymentDetails(amount, reference),
      message: 'تم إنشاء طلب الدفع. الباقة تتفعل بعد مراجعة التحويل.',
    };
  }

  async submitPayment(
    userId: string,
    purchaseId: string,
    input: {
      transactionReference?: string | null;
      transferredAt?: string | null;
      screenshot?: { mime: string; bytes: Buffer } | null;
    },
  ) {
    const senderPhone = normalizeTransactionReference(input.transactionReference);
    if (!senderPhone) {
      throw new AppException('اكتب رقم الموبايل اللي حوّلت منه', 400);
    }
    if (!input.screenshot) {
      throw new AppException('ارفع صورة التحويل', 400);
    }
    const problem = validateScreenshot(input.screenshot.mime, input.screenshot.bytes.length);
    if (problem === 'UNSUPPORTED_SCREENSHOT') {
      throw new AppException('صورة التحويل لازم تكون JPG أو PNG أو WEBP', 400);
    }
    if (problem) throw new AppException('صورة التحويل أكبر من 5 ميجا', 400);
    const screenshot = `data:${input.screenshot.mime};base64,${input.screenshot.bytes.toString('base64')}`;
    const transferredAt = input.transferredAt ? new Date(input.transferredAt) : null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const purchase = await tx.packagePurchase.findFirst({
          where: { id: purchaseId, isDeleted: false },
        });
        if (!purchase || purchase.userId !== userId) {
          throw new NotFoundException('طلب الدفع غير موجود');
        }
        if (purchase.status === PurchaseStatus.Paid) {
          throw new AppException('تم تأكيد هذا الدفع بالفعل', 400, ErrorCodes.PackagePaymentNotVerifiable);
        }
        if (purchase.status === PurchaseStatus.PendingVerification) {
          return this.presentPurchase(purchase);
        }
        let next: string;
        try {
          next = submitPurchaseStatus(purchase.status);
        } catch {
          throw new AppException('لا يمكن إرسال هذا الطلب', 400, ErrorCodes.PackagePaymentNotVerifiable);
        }
        const updated = await tx.packagePurchase.update({
          where: { id: purchase.id },
          data: {
            status: next,
            transactionReference: input.transactionReference?.trim() || senderPhone,
            transactionReferenceNormalized: `${senderPhone}:${purchase.id}`,
            transferredAt: transferredAt && !Number.isNaN(transferredAt.getTime()) ? transferredAt : null,
            screenshotStorage: screenshot,
            submittedAt: utcNow(),
            rejectionReason: null,
            updatedAt: utcNow(),
          },
        });
        await this.audit(tx, purchase.id, userId, 'SUBMITTED', senderPhone);
        return this.presentPurchase(updated);
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppException(
          'رقم العملية مستخدم من قبل',
          409,
          ErrorCodes.DuplicateTransactionReference,
        );
      }
      throw error;
    }
  }

  async myPurchases(userId: string) {
    const rows = await this.prisma.packagePurchase.findMany({
      where: { userId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      include: {
        package: { include: { route: { select: { name: true } } } },
      },
    });
    return rows.map((row) => ({
      ...this.presentPurchase(row),
      packageName: row.package.name,
      routeName: row.package.route?.name ?? null,
      tripCount: row.package.tripCount,
      validityDays: row.package.validityDays,
      direction: normalizeDirection(row.package.direction),
    }));
  }

  async usageForUser(userId: string) {
    await this.expireStale(this.prisma, userId);
    const rows = await this.prisma.userSubscription.findMany({
      where: { userId, isDeleted: false },
      include: {
        package: true,
        route: { select: { id: true, name: true } },
        reservations: {
          where: { isDeleted: false },
          include: {
            booking: {
              include: {
                originStop: { select: { name: true } },
                destinationStop: { select: { name: true } },
                trip: {
          select: {
            scheduledAt: true,
            status: true,
            route: { select: { vehicleKind: true, name: true } },
          },
        },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
      orderBy: { expiresAt: 'asc' },
    });
    return rows.map((row) => this.presentSubscription(row));
  }

  async eligibleForTrip(
    userId: string,
    tripId: string,
    originStopId?: string | null,
    destinationStopId?: string | null,
  ) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, isDeleted: false },
      include: { route: { select: { id: true, name: true, vehicleKind: true } } },
    });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة', ErrorCodes.TripNotFound);
    const stops = await this.prisma.stop.findMany({
      where: {
        id: { in: [originStopId, destinationStopId].filter((id): id is string => Boolean(id)) },
        isDeleted: false,
      },
      select: { id: true, order: true, name: true },
    });
    const origin = stops.find((stop) => stop.id === originStopId);
    const destination = stops.find((stop) => stop.id === destinationStopId);
    await this.expireStale(this.prisma, userId);
    const rows = await this.prisma.userSubscription.findMany({
      where: { userId, isDeleted: false, status: SubscriptionStatus.Active },
      include: { package: true, route: { select: { name: true } } },
    });
    const ledgers = rows.map((row) => this.toLedger(row));
    const context = {
      routeId: trip.routeId,
      direction: tripDirection(origin?.order, destination?.order),
      vehicleKind: trip.route.vehicleKind,
      now: utcNow(),
      stopNames: lineLabels(trip.route.name).concat(
        [origin?.name, destination?.name].filter((name): name is string => Boolean(name)),
      ),
    };
    const options = ledgers
      .filter((row) => isEligible(row, context))
      .sort((a, b) => (a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
    return {
      routeId: trip.routeId,
      routeName: trip.route.name,
      options: options.map((row, index) => {
        const source = rows.find((item) => item.id === row.id);
        return {
          subscriptionId: row.id,
          packageId: row.packageId,
          packageName: source?.package.name ?? '',
          routeName: source?.route?.name ?? trip.route.name,
          remainingTrips: this.finiteRemaining(row),
          ridesTotal: row.ridesTotal,
          expiresAt: row.expiresAt,
          direction: row.direction,
          selected: index === 0,
        };
      }),
    };
  }

  async reserveForBooking(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      bookingId: string;
      routeId: string;
      originOrder: number | null;
      destinationOrder: number | null;
      vehicleKind: string | null;
      subscriptionId?: string | null;
      stopNames?: string[];
    },
  ): Promise<'ledger' | 'legacy'> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pkg:${input.userId}`}))`;
    await this.expireStale(tx, input.userId);
    const rows = await tx.userSubscription.findMany({
      where: { userId: input.userId, isDeleted: false },
      include: { route: { select: { name: true } } },
    });
    if (rows.length === 0) return 'legacy';
    const context = {
      routeId: input.routeId,
      direction: tripDirection(input.originOrder, input.destinationOrder),
      vehicleKind: input.vehicleKind,
      now: utcNow(),
      stopNames: input.stopNames,
    };
    const chosen = pickSubscription(
      rows.map((row) => this.toLedger(row)),
      context,
      input.subscriptionId,
    );
    if (!chosen) {
      throw new AppException(
        'الباقة لا تغطي هذا الخط أو لا توجد رحلات متبقية',
        400,
        ErrorCodes.PackageNotEligible,
      );
    }
    const taken = await tx.$executeRaw`
      UPDATE "UserSubscriptionsSet"
      SET "RidesReserved" = "RidesReserved" + 1,
          "UpdatedAt" = NOW()
      WHERE "Id" = ${chosen.id}::uuid
        AND "UserId" = ${input.userId}::uuid
        AND "Status" = ${SubscriptionStatus.Active}
        AND "IsDeleted" = false
        AND ("ExpiresAt" IS NULL OR "ExpiresAt" >= NOW())
        AND ("RidesTotal" <= 0 OR "RidesUsed" + "RidesReserved" < "RidesTotal")`;
    if (Number(taken) !== 1) {
      throw new AppException(
        'لقد استنفدت رحلات الباقة. اشترك في باقة جديدة أو ادفع نقدًا.',
        400,
        ErrorCodes.SubscriptionLimitReached,
      );
    }
    await tx.ridePackageReservation.create({
      data: {
        id: newId(),
        subscriptionId: chosen.id,
        bookingId: input.bookingId,
        status: ReservationStatus.Reserved,
        ...baseFields(),
      },
    });
    return 'ledger';
  }

  async releaseBooking(tx: Prisma.TransactionClient, bookingId: string) {
    const reservation = await tx.ridePackageReservation.findFirst({
      where: { bookingId, isDeleted: false },
    });
    if (!reservation || reservation.status !== ReservationStatus.Reserved) return;
    await tx.$executeRaw`
      UPDATE "UserSubscriptionsSet"
      SET "RidesReserved" = GREATEST("RidesReserved" - 1, 0),
          "UpdatedAt" = NOW()
      WHERE "Id" = ${reservation.subscriptionId}::uuid`;
    await tx.ridePackageReservation.update({
      where: { id: reservation.id },
      data: { status: ReservationStatus.Released, updatedAt: utcNow() },
    });
  }

  async releaseTrip(tripId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { tripId, isDeleted: false },
      select: { id: true },
    });
    await this.prisma.$transaction(async (tx) => {
      for (const booking of bookings) {
        await this.releaseBooking(tx, booking.id);
      }
    });
  }

  async finalizeTrip(tripId: string, transaction?: Prisma.TransactionClient) {
    const finalize = async (tx: Prisma.TransactionClient) => {
      const reservations = await tx.ridePackageReservation.findMany({
        where: {
          isDeleted: false,
          status: ReservationStatus.Reserved,
          booking: { tripId, isDeleted: false },
        },
      });
      for (const reservation of reservations) {
        const subscription = await tx.userSubscription.findFirst({
          where: { id: reservation.subscriptionId },
        });
        if (!subscription) continue;
        const next = applyFinalize(this.toLedger(subscription), reservation.status);
        if (!next.deducted) continue;
        const marked = await tx.ridePackageReservation.updateMany({
          where: { id: reservation.id, status: ReservationStatus.Reserved },
          data: { status: ReservationStatus.Finalized, updatedAt: utcNow() },
        });
        if (marked.count !== 1) continue;
        await tx.$executeRaw`
          UPDATE "UserSubscriptionsSet"
          SET "RidesUsed" = "RidesUsed" + 1,
              "RidesReserved" = GREATEST("RidesReserved" - 1, 0),
              "Status" = CASE
                WHEN "RidesTotal" > 0 AND "RidesUsed" + 1 >= "RidesTotal" THEN ${SubscriptionStatus.Exhausted}
                ELSE "Status"
              END,
              "UpdatedAt" = NOW()
          WHERE "Id" = ${subscription.id}::uuid`;
      }
    };
    if (transaction) {
      await finalize(transaction);
      return;
    }
    await this.prisma.$transaction(finalize);
  }

  async adminListPurchases(status?: string) {
    const rows = await this.prisma.packagePurchase.findMany({
      where: {
        isDeleted: false,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        user: { select: { fullName: true, phone: true } },
        package: { include: { route: { select: { name: true } } } },
        audits: { orderBy: { createdAt: 'asc' } },
      },
    });
    return rows.map((row) => ({
      ...this.presentPurchase(row, false),
      customerName: row.user.fullName,
      customerPhone: row.user.phone,
      packageName: row.package.name,
      routeName: row.package.route?.name ?? null,
      amount: money(row.amount),
      hasScreenshot: Boolean(row.screenshotStorage),
      screenshot: row.screenshotStorage,
      audits: row.audits.map((audit) => ({
        id: audit.id,
        action: audit.action,
        note: audit.note,
        actorUserId: audit.actorUserId,
        createdAt: audit.createdAt,
      })),
    }));
  }

  async adminApprove(purchaseId: string, adminId: string, note?: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const purchase = await tx.packagePurchase.findFirst({
          where: { id: purchaseId, isDeleted: false },
          include: { package: true, subscription: true },
        });
        if (!purchase) throw new NotFoundException('طلب الدفع غير موجود');
        const known = await tx.packagePurchase.findMany({
          where: {
            isDeleted: false,
            id: { not: purchase.id },
            transactionReferenceNormalized: purchase.transactionReferenceNormalized,
            status: { notIn: [PurchaseStatus.Rejected, PurchaseStatus.Cancelled] },
          },
          select: { transactionReferenceNormalized: true },
        });
        const decision = approvePurchase({
          status: purchase.status,
          transactionReference: purchase.transactionReference,
          knownReferences: new Set(
            known
              .map((row) => row.transactionReferenceNormalized)
              .filter((value): value is string => Boolean(value)),
          ),
          alreadyHasSubscription: Boolean(purchase.subscription),
        });
        if (!decision.activate) {
          return {
            purchaseId: purchase.id,
            userId: purchase.userId,
            packageName: purchase.package.name,
            status: PurchaseStatus.Paid,
            activated: false,
            idempotent: true,
          };
        }
        const activatedAt = utcNow();
        const expiresAt = addDays(activatedAt, purchase.package.validityDays);
        const subscriptionId = newId();
        await tx.userSubscription.create({
          data: {
            id: subscriptionId,
            userId: purchase.userId,
            packageId: purchase.packageId,
            routeId: purchase.package.routeId,
            purchaseId: purchase.id,
            status: SubscriptionStatus.Active,
            direction: normalizeDirection(purchase.package.direction),
            vehicleKind: purchase.package.vehicleKind,
            ridesTotal: purchase.package.tripCount,
            ridesUsed: 0,
            ridesReserved: 0,
            activatedAt,
            expiresAt,
            ...baseFields(activatedAt),
          },
        });
        await tx.packagePurchase.update({
          where: { id: purchase.id },
          data: {
            status: PurchaseStatus.Paid,
            verifiedAt: activatedAt,
            verifiedByUserId: adminId,
            subscriptionId,
            updatedAt: activatedAt,
          },
        });
        const user = await tx.user.findFirst({
          where: { id: purchase.userId },
          select: { activeSubscriptionPackageId: true },
        });
        if (!user?.activeSubscriptionPackageId) {
          await tx.user.update({
            where: { id: purchase.userId },
            data: {
              activeSubscriptionPackageId: purchase.packageId,
              subscriptionActivatedAt: activatedAt,
              subscriptionExpiresAt: expiresAt,
            },
          });
        }
        await this.audit(tx, purchase.id, adminId, 'APPROVED', note ?? null);
        return {
          purchaseId: purchase.id,
          userId: purchase.userId,
          packageName: purchase.package.name,
          subscriptionId,
          status: PurchaseStatus.Paid,
          activated: true,
          activatedAt,
          expiresAt,
          idempotent: false,
        };
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'DUPLICATE_REF') {
        throw new AppException(
          'رقم العملية مستخدم في طلب آخر',
          409,
          ErrorCodes.DuplicateTransactionReference,
        );
      }
      if (error instanceof Error && (error.message === 'INVALID_APPROVE' || error.message === 'MISSING_REF')) {
        throw new AppException(
          'لا يمكن تأكيد طلب لم يُرسل رقمه بعد',
          400,
          ErrorCodes.PackagePaymentNotVerifiable,
        );
      }
      if (this.isUniqueViolation(error)) {
        throw new AppException(
          'رقم العملية مستخدم من قبل',
          409,
          ErrorCodes.DuplicateTransactionReference,
        );
      }
      throw error;
    }
  }

  async adminReject(purchaseId: string, adminId: string, reason: string) {
    const note = reason.trim();
    if (!note) throw new AppException('اكتب سبب الرفض', 400);
    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.packagePurchase.findFirst({
        where: { id: purchaseId, isDeleted: false },
        include: { package: { select: { name: true } } },
      });
      if (!purchase) throw new NotFoundException('طلب الدفع غير موجود');
      let changed = true;
      try {
        changed = rejectPurchase(purchase.status).changed;
      } catch (error) {
        if (error instanceof Error && error.message === 'PAID_LOCKED') {
          throw new AppException('لا يمكن رفض دفعة تم تأكيدها', 400);
        }
        throw new AppException('لا يمكن رفض هذا الطلب', 400);
      }
      if (changed) {
        await tx.packagePurchase.update({
          where: { id: purchase.id },
          data: {
            status: PurchaseStatus.Rejected,
            rejectionReason: note,
            verifiedAt: utcNow(),
            verifiedByUserId: adminId,
            updatedAt: utcNow(),
          },
        });
      }
      await this.audit(tx, purchase.id, adminId, 'REJECTED', note);
      return {
        purchaseId: purchase.id,
        userId: purchase.userId,
        packageName: purchase.package.name,
        status: PurchaseStatus.Rejected,
        changed,
      };
    });
  }

  packageFields(pkg: {
    routeId?: string | null;
    direction?: string | null;
    vehicleKind?: string | null;
    route?: { id: string; name: string } | null;
  }) {
    return {
      routeId: pkg.routeId ?? null,
      routeName: pkg.route?.name ?? null,
      direction: normalizeDirection(pkg.direction),
      vehicleKind: pkg.vehicleKind ?? null,
    };
  }

  private presentSubscription(row: {
    id: string;
    packageId: string;
    status: string;
    ridesTotal: number;
    ridesUsed: number;
    ridesReserved: number;
    direction: string;
    vehicleKind: string | null;
    activatedAt: Date | null;
    expiresAt: Date | null;
    package: { name: string; price: Prisma.Decimal; validityDays: number };
    route: { name: string } | null;
    reservations?: Array<{
      id: string;
      status: string;
      booking: {
        id: string;
        referenceCode: string | null;
        originStop: { name: string } | null;
        destinationStop: { name: string } | null;
        vehicleKind?: string | null;
        trip: {
          scheduledAt: Date;
          status: number;
          route?: { vehicleKind: string | null; name: string } | null;
        } | null;
        createdAt: Date;
      };
    }>;
  }) {
    const ledger = this.toLedger(row);
    return {
      subscriptionId: row.id,
      packageId: row.packageId,
      packageName: row.package.name,
      title: row.package.name,
      status: row.status,
      price: money(row.package.price),
      validityDays: row.package.validityDays,
      routeName: row.route?.name ?? null,
      direction: normalizeDirection(row.direction),
      vehicleKind: row.vehicleKind,
      ridesTotal: row.ridesTotal,
      ridesUsed: row.ridesUsed,
      ridesReserved: row.ridesReserved,
      remainingTrips: this.finiteRemaining(ledger),
      activatedAt: row.activatedAt,
      expiresAt: row.expiresAt,
      isActive: row.status === SubscriptionStatus.Active,
      bookings: (row.reservations ?? [])
        .filter((reservation) => reservation.status !== ReservationStatus.Released)
        .map((reservation) => ({
          id: reservation.booking.id,
          referenceCode: reservation.booking.referenceCode ?? '',
          status:
            reservation.status === ReservationStatus.Finalized
              ? 'finished'
              : 'upcoming',
          scheduledAt: reservation.booking.trip?.scheduledAt ?? reservation.booking.createdAt,
          from: reservation.booking.originStop?.name ?? '',
          to: reservation.booking.destinationStop?.name ?? '',
          vehicleKind:
            reservation.booking.vehicleKind ||
            reservation.booking.trip?.route?.vehicleKind ||
            row.vehicleKind ||
            '',
        })),
    };
  }

  private presentPurchase(
    row: {
      id: string;
      status: string;
      amount: Prisma.Decimal;
      currency: string;
      publicReference: string;
      transactionReference: string | null;
      submittedAt: Date | null;
      verifiedAt: Date | null;
      rejectionReason: string | null;
      packageId: string;
      createdAt: Date;
    },
    includeInstructions = true,
  ) {
    const amount = money(row.amount);
    return {
      purchaseId: row.id,
      packageId: row.packageId,
      status: row.status,
      activated: row.status === PurchaseStatus.Paid,
      amount,
      currency: row.currency,
      reference: row.publicReference,
      transactionReference: row.transactionReference,
      submittedAt: row.submittedAt,
      verifiedAt: row.verifiedAt,
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt,
      ...(includeInstructions
        ? { instapay: this.paymentDetails(amount, row.publicReference) }
        : {}),
    };
  }

  private toLedger(row: {
    id: string;
    userId?: string;
    packageId: string;
    routeId?: string | null;
    route?: { name: string } | null;
    direction: string;
    vehicleKind: string | null;
    status: string;
    ridesTotal: number;
    ridesUsed: number;
    ridesReserved: number;
    expiresAt: Date | null;
  }): SubscriptionLedger {
    return {
      id: row.id,
      userId: row.userId ?? '',
      packageId: row.packageId,
      routeId: row.routeId ?? null,
      routeName: row.route?.name ?? null,
      direction: normalizeDirection(row.direction),
      vehicleKind: row.vehicleKind,
      status: row.status,
      ridesTotal: row.ridesTotal,
      ridesUsed: row.ridesUsed,
      ridesReserved: row.ridesReserved,
      expiresAt: row.expiresAt,
    };
  }

  private finiteRemaining(row: SubscriptionLedger): number | null {
    const value = remainingRides(row);
    return Number.isFinite(value) ? value : null;
  }

  private async expireStale(db: Db, userId: string) {
    await db.userSubscription.updateMany({
      where: {
        userId,
        isDeleted: false,
        status: { in: ACTIVE_LIKE },
        expiresAt: { lt: utcNow() },
      },
      data: { status: SubscriptionStatus.Expired, updatedAt: utcNow() },
    });
  }

  private async audit(
    db: Db,
    purchaseId: string,
    actorUserId: string | null,
    action: string,
    note: string | null,
  ) {
    await db.packagePaymentAudit.create({
      data: {
        id: newId(),
        purchaseId,
        actorUserId,
        action,
        note,
        createdAt: utcNow(),
      },
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

export { isPackageFunded };
