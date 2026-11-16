import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CurrentUserService } from '../../common/current-user.service';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  BookingStatus,
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import {
  DEFAULT_PLATFORM_COMMISSION_PERCENT,
  money,
  normalizeMoney,
  platformCut,
} from '../../common/utils/money';
import { toDataUrlStoragePath } from '../../common/utils/document-storage';

export const PLATFORM_INSTAPAY_PHONE = '01024139097';

const PaymentStatus = {
  PendingReview: 1,
  Confirmed: 2,
} as const;

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class CaptainPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  async summary() {
    const driver = await this.requireDriver();
    return this.buildSummary(driver.id);
  }

  async submit(
    senderPhoneRaw: string | undefined,
    file?: { originalname: string; mimetype: string; buffer: Buffer; size: number },
  ) {
    const driver = await this.requireDriver();
    const senderPhone = normalizeEgyptianMobile(senderPhoneRaw);
    if (!file?.buffer?.length) {
      throw new AppException('ارفع صورة التحويل');
    }
    const mime = (file.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) {
      throw new AppException('صورة التحويل لازم تكون صورة');
    }
    if (file.size > 4 * 1024 * 1024) {
      throw new AppException('صورة التحويل أكبر من 4 ميجا');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const ledger = await this.ledger(driver.id, tx);
      if (ledger.payableAmount < 0.01) {
        throw new AppException('لا يوجد مبلغ مستحق للدفع الآن');
      }
      return tx.captainCommissionPayment.create({
        data: {
          id: newId(),
          driverId: driver.id,
          amount: new Prisma.Decimal(ledger.payableAmount),
          senderPhone,
          receiptStorage: toDataUrlStoragePath(file),
          status: PaymentStatus.PendingReview,
          ...baseFields(),
        },
      });
    });

    return {
      ...(await this.buildSummary(driver.id)),
      submitted: this.mapPayment(created),
    };
  }

  async adminList() {
    const rows = await this.prisma.captainCommissionPayment.findMany({
      where: { isDeleted: false },
      orderBy: { createdAt: 'desc' },
      include: {
        driver: {
          include: { user: { select: { fullName: true, phone: true } } },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      driverId: row.driverId,
      captainName: row.driver.user.fullName?.trim() || 'كابتن',
      captainPhone: row.driver.user.phone,
      amount: money(row.amount),
      senderPhone: row.senderPhone,
      status: statusKey(row.status),
      statusLabel: statusLabel(row.status),
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
    }));
  }

  async adminDetail(id: string) {
    const row = await this.prisma.captainCommissionPayment.findFirst({
      where: { id, isDeleted: false },
      include: {
        driver: {
          include: { user: { select: { fullName: true, phone: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException('الدفعة غير موجودة');
    return {
      id: row.id,
      driverId: row.driverId,
      captainName: row.driver.user.fullName?.trim() || 'كابتن',
      captainPhone: row.driver.user.phone,
      amount: money(row.amount),
      senderPhone: row.senderPhone,
      receiptImage: row.receiptStorage,
      status: statusKey(row.status),
      statusLabel: statusLabel(row.status),
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
    };
  }

  async adminConfirm(id: string) {
    const row = await this.prisma.captainCommissionPayment.findFirst({
      where: { id, isDeleted: false },
    });
    if (!row) throw new NotFoundException('الدفعة غير موجودة');
    if (row.status === PaymentStatus.Confirmed) {
      return this.adminDetail(id);
    }
    await this.prisma.captainCommissionPayment.update({
      where: { id: row.id },
      data: {
        status: PaymentStatus.Confirmed,
        confirmedAt: utcNow(),
        confirmedByUserId: this.currentUser.requireUserId(),
        updatedAt: utcNow(),
      },
    });
    return this.adminDetail(id);
  }

  private async buildSummary(driverId: string) {
    const ledger = await this.ledger(driverId, this.prisma);
    const payments = await this.prisma.captainCommissionPayment.findMany({
      where: { driverId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
    return {
      grossTotal: ledger.grossTotal,
      captainEarnings: ledger.captainEarnings,
      appCommission: ledger.appCommission,
      paidAmount: ledger.paidAmount,
      pendingAmount: ledger.pendingAmount,
      payableAmount: ledger.payableAmount,
      commissionPercent: DEFAULT_PLATFORM_COMMISSION_PERCENT,
      instapayPhone: PLATFORM_INSTAPAY_PHONE,
      payments: payments.map((row) => this.mapPayment(row)),
    };
  }

  private mapPayment(row: {
    id: string;
    amount: Prisma.Decimal;
    senderPhone: string;
    status: number;
    createdAt: Date;
    confirmedAt: Date | null;
  }) {
    return {
      id: row.id,
      amount: money(row.amount),
      senderPhone: row.senderPhone,
      status: statusKey(row.status),
      statusLabel: statusLabel(row.status),
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
    };
  }

  private async ledger(driverId: string, db: Db) {
    const [rides, groups, trips, payments] = await Promise.all([
      db.rideRequest.findMany({
        where: {
          driverId,
          isDeleted: false,
          status: RideRequestStatus.Completed,
        },
        select: { totalAmount: true, fareAmount: true },
      }),
      db.groupRequest.findMany({
        where: {
          driverId,
          isDeleted: false,
          status: GroupRequestStatus.Completed,
        },
        select: { totalAmount: true, fareAmount: true },
      }),
      db.trip.findMany({
        where: {
          driverId,
          isDeleted: false,
          status: TripStatus.Completed,
        },
        select: {
          bookings: {
            where: { isDeleted: false, status: BookingStatus.Confirmed },
            select: { totalAmount: true, pricePerSeat: true, seatCount: true },
          },
        },
      }),
      db.captainCommissionPayment.findMany({
        where: { driverId, isDeleted: false },
        select: { amount: true, status: true },
      }),
    ]);

    let grossTotal = 0;
    const add = (total: number) => {
      if (total > 0) grossTotal = normalizeMoney(grossTotal + total);
    };
    for (const ride of rides) add(money(ride.totalAmount) || money(ride.fareAmount));
    for (const group of groups) add(money(group.totalAmount) || money(group.fareAmount));
    for (const trip of trips) {
      const total = trip.bookings.reduce((sum, booking) => {
        const row =
          money(booking.totalAmount) > 0
            ? money(booking.totalAmount)
            : money(booking.pricePerSeat) * booking.seatCount;
        return sum + row;
      }, 0);
      add(total);
    }

    const cut = platformCut(grossTotal);
    const paidAmount = normalizeMoney(
      payments
        .filter((row) => row.status === PaymentStatus.Confirmed)
        .reduce((sum, row) => sum + money(row.amount), 0),
    );
    const pendingAmount = normalizeMoney(
      payments
        .filter((row) => row.status === PaymentStatus.PendingReview)
        .reduce((sum, row) => sum + money(row.amount), 0),
    );
    const payableAmount = normalizeMoney(
      Math.max(0, cut.appCommission - paidAmount - pendingAmount),
    );
    return {
      grossTotal: cut.total,
      captainEarnings: cut.captainEarnings,
      appCommission: cut.appCommission,
      paidAmount,
      pendingAmount,
      payableAmount,
    };
  }

  private async requireDriver() {
    const userId = this.currentUser.requireUserId();
    const driver = await this.prisma.driver.findFirst({
      where: { userId, isDeleted: false },
    });
    if (!driver) {
      throw new AppException('حساب الكابتن غير موجود', 404, ErrorCodes.DriverNotFound);
    }
    if (!driver.isActive) {
      throw new AppException('حساب الكابتن غير موجود أو غير نشط', 403, ErrorCodes.DriverNotEligible);
    }
    return driver;
  }
}

function normalizeEgyptianMobile(raw: string | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  const local = digits.startsWith('20') && digits.length === 12 ? `0${digits.slice(2)}` : digits;
  if (!/^01\d{9}$/.test(local)) {
    throw new AppException('اكتب رقم الموبايل اللي حوّلت منه');
  }
  return local;
}

function statusKey(status: number): 'pending' | 'confirmed' {
  return status === PaymentStatus.Confirmed ? 'confirmed' : 'pending';
}

function statusLabel(status: number): string {
  return status === PaymentStatus.Confirmed ? 'تم الدفع' : 'بانتظار المراجعة من قبل الادارة';
}
