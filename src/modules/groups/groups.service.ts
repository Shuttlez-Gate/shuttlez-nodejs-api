import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { GroupRequestStatus } from '../../common/enums';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import { money, refCode, requireCash, splitEarnings } from '../../common/utils/money';
import { groupStatusLabel } from '../../common/utils/enums-map';
import { FareService } from '../pricing/fare.service';

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
  ) {}

  async quote(query: {
    fromZoneKey?: string;
    toZoneKey?: string;
    pickupLatitude?: number;
    pickupLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
  }) {
    this.currentUser.requireUserId();
    const rule = await this.fare.resolveGroupRule(query.fromZoneKey, query.toZoneKey);
    const distanceKm = this.fare.distanceKm(
      query.pickupLatitude,
      query.pickupLongitude,
      query.destinationLatitude,
      query.destinationLongitude,
    );
    const fareAmount = this.fare.groupFare(rule, distanceKm);
    const platformPercent = await this.fare.platformCommissionPercent();
    const split = splitEarnings(fareAmount, platformPercent);
    const perKm = money(rule.pricePerKm) > 0;
    return {
      groupFareRuleId: rule.id,
      ruleName: rule.name,
      fromZoneKey: rule.fromZoneKey,
      toZoneKey: rule.toZoneKey,
      charterFlatFare: money(rule.charterFlatFare),
      maxMembers: rule.maxMembers,
      platformCommissionPercent: platformPercent,
      commissionAmount: split.commissionAmount,
      captainEarnings: split.captainEarnings,
      totalAmount: fareAmount,
      paymentMethodHint: 'cash',
      distanceKm,
      baseFare: perKm ? money(rule.baseFare) : null,
      pricePerKm: perKm ? money(rule.pricePerKm) : null,
      minimumFare: perKm && rule.minimumFare != null ? money(rule.minimumFare) : null,
    };
  }

  async fareOptions() {
    this.currentUser.requireUserId();
    const asOf = new Date();
    const rules = await this.prisma.groupFareRule.findMany({
      where: { isDeleted: false, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    return rules
      .filter(
        (r) =>
          (r.effectiveFrom == null || r.effectiveFrom <= asOf) &&
          (r.effectiveTo == null || r.effectiveTo >= asOf) &&
          r.maxMembers >= 1 &&
          (money(r.charterFlatFare) > 0 || money(r.pricePerKm) > 0),
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        fromZoneKey: r.fromZoneKey,
        toZoneKey: r.toZoneKey,
        charterFlatFare: money(r.charterFlatFare),
        maxMembers: r.maxMembers,
      }));
  }

  async create(body: {
    pickupLatitude: number;
    pickupLongitude: number;
    destinationLatitude: number;
    destinationLongitude: number;
    capacity: number;
    pickupAddress?: string;
    destinationAddress?: string;
    fromZoneKey?: string;
    toZoneKey?: string;
  }) {
    const userId = this.currentUser.requireUserId();
    const rule = await this.fare.resolveGroupRule(body.fromZoneKey, body.toZoneKey);
    if (body.capacity < 1 || body.capacity > rule.maxMembers) {
      throw new AppException(
        `سعة المجموعة يجب أن تكون بين 1 و ${rule.maxMembers}`,
        400,
        ErrorCodes.GroupInvalidCapacity,
      );
    }
    const distanceKm = this.fare.distanceKm(
      body.pickupLatitude,
      body.pickupLongitude,
      body.destinationLatitude,
      body.destinationLongitude,
    );
    const fareAmount = this.fare.groupFare(rule, distanceKm);
    const platformPercent = await this.fare.platformCommissionPercent();
    const split = splitEarnings(fareAmount, platformPercent);
    const perKm = money(rule.pricePerKm) > 0;
    const id = newId();
    await this.prisma.$transaction([
      this.prisma.groupRequest.create({
        data: {
          id,
          organizerUserId: userId,
          pickupLatitude: body.pickupLatitude,
          pickupLongitude: body.pickupLongitude,
          pickupAddress: trimOrNull(body.pickupAddress),
          destinationLatitude: body.destinationLatitude,
          destinationLongitude: body.destinationLongitude,
          destinationAddress: trimOrNull(body.destinationAddress),
          fromZoneKey: trimOrNull(body.fromZoneKey),
          toZoneKey: trimOrNull(body.toZoneKey),
          groupFareRuleId: rule.id,
          capacity: body.capacity,
          joinedMemberCount: 1,
          status: GroupRequestStatus.Draft,
          fareAmount,
          commissionRate: split.commissionRate,
          commissionAmount: split.commissionAmount,
          captainEarnings: split.captainEarnings,
          totalAmount: fareAmount,
          paymentMethod: 'cash',
          isCashConfirmed: false,
          membershipLocked: false,
          referenceCode: refCode('GR'),
          distanceKm: distanceKm == null ? null : new Prisma.Decimal(distanceKm),
          baseFareApplied: perKm ? rule.baseFare : null,
          pricePerKmApplied: perKm ? rule.pricePerKm : null,
          minimumFareApplied: perKm ? rule.minimumFare : null,
          ...baseFields(),
        },
      }),
      this.prisma.groupMember.create({
        data: {
          id: newId(),
          groupRequestId: id,
          userId,
          isOrganizer: true,
          joinedAt: utcNow(),
          ...baseFields(),
        },
      }),
    ]);
    return this.byId(id);
  }

  async join(groupId: string) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    if (group.membershipLocked || group.status !== GroupRequestStatus.Draft) {
      throw new AppException(
        'لا يمكن الانضمام لهذه المجموعة',
        400,
        ErrorCodes.GroupMembershipLocked,
      );
    }
    if (group.members.some((m) => m.userId === userId && !m.isDeleted)) {
      throw new AppException(
        'أنت عضو بالفعل في هذه المجموعة',
        400,
        ErrorCodes.GroupDuplicateMember,
      );
    }
    if (group.joinedMemberCount >= group.capacity) {
      throw new AppException(
        'المجموعة ممتلئة',
        400,
        ErrorCodes.GroupCapacityExceeded,
      );
    }
    await this.prisma.$transaction([
      this.prisma.groupMember.create({
        data: {
          id: newId(),
          groupRequestId: groupId,
          userId,
          isOrganizer: false,
          joinedAt: utcNow(),
          ...baseFields(),
        },
      }),
      this.prisma.groupRequest.update({
        where: { id: groupId },
        data: {
          joinedMemberCount: { increment: 1 },
          updatedAt: utcNow(),
        },
      }),
    ]);
    return this.byId(groupId);
  }

  async leave(groupId: string) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    const member = group.members.find((m) => m.userId === userId && !m.isDeleted);
    if (!member) {
      throw new AppException('لست عضواً في المجموعة', 400, ErrorCodes.GroupNotMember);
    }
    if (member.isOrganizer) {
      throw new AppException(
        'المنظّم لا يمكنه المغادرة — ألغِ المجموعة بدلاً من ذلك',
        400,
        ErrorCodes.GroupMembershipLocked,
      );
    }
    if (group.membershipLocked) {
      throw new AppException(
        'لا يمكن مغادرة المجموعة بعد التأكيد',
        400,
        ErrorCodes.GroupMembershipLocked,
      );
    }
    await this.prisma.$transaction([
      this.prisma.groupMember.update({
        where: { id: member.id },
        data: { isDeleted: true, updatedAt: utcNow() },
      }),
      this.prisma.groupRequest.update({
        where: { id: groupId },
        data: { joinedMemberCount: { decrement: 1 }, updatedAt: utcNow() },
      }),
    ]);
    return this.byId(groupId);
  }

  async confirm(groupId: string, paymentMethod?: string) {
    this.currentUser.requireUserId();
    requireCash(paymentMethod);
    const group = await this.requireGroup(groupId);
    const userId = this.currentUser.userId!;
    if (group.organizerUserId !== userId) {
      throw new AppException('المنظّم فقط يمكنه تأكيد المجموعة', 403);
    }
    if (group.status !== GroupRequestStatus.Draft) {
      throw new AppException(
        'لا يمكن تأكيد هذه المجموعة',
        400,
        ErrorCodes.GroupNotConfirmable,
      );
    }
    await this.prisma.groupRequest.update({
      where: { id: groupId },
      data: {
        status: GroupRequestStatus.Confirmed,
        isCashConfirmed: true,
        membershipLocked: true,
        confirmedAt: utcNow(),
        updatedAt: utcNow(),
      },
    });
    return this.byId(groupId);
  }

  async mine() {
    const userId = this.currentUser.requireUserId();
    const memberships = await this.prisma.groupMember.findMany({
      where: { userId, isDeleted: false },
      select: { groupRequestId: true },
    });
    const ids = memberships.map((m) => m.groupRequestId);
    const items = await this.prisma.groupRequest.findMany({
      where: { id: { in: ids }, isDeleted: false },
      include: groupInclude,
      orderBy: { createdAt: 'desc' },
    });
    return items.map((g) => this.mapGroup(g));
  }

  async byId(groupId: string) {
    this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    const userId = this.currentUser.userId!;
    const isMember = group.members.some((m) => m.userId === userId && !m.isDeleted);
    if (!isMember && !this.currentUser.isAdmin) {
      throw new AppException('غير مصرح', 403);
    }
    return this.mapGroup(group);
  }

  async cancel(groupId: string) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    if (group.organizerUserId !== userId && !this.currentUser.isAdmin) {
      throw new AppException('المنظّم فقط يمكنه الإلغاء', 403);
    }
    if (
      group.status === GroupRequestStatus.Completed ||
      group.status === GroupRequestStatus.Cancelled
    ) {
      throw new AppException(
        'لا يمكن إلغاء هذه المجموعة',
        400,
        ErrorCodes.GroupNotCancellable,
      );
    }
    await this.prisma.groupRequest.update({
      where: { id: groupId },
      data: {
        status: GroupRequestStatus.Cancelled,
        cancelledAt: utcNow(),
        updatedAt: utcNow(),
      },
    });
    return this.byId(groupId);
  }

  private async requireGroup(id: string) {
    const group = await this.prisma.groupRequest.findFirst({
      where: { id, isDeleted: false },
      include: groupInclude,
    });
    if (!group) {
      throw new NotFoundException('المجموعة غير موجودة', ErrorCodes.GroupNotFound);
    }
    return group;
  }

  mapGroup(group: GroupRow) {
    return {
      id: group.id,
      organizerUserId: group.organizerUserId,
      pickupLatitude: group.pickupLatitude,
      pickupLongitude: group.pickupLongitude,
      pickupAddress: group.pickupAddress,
      destinationLatitude: group.destinationLatitude,
      destinationLongitude: group.destinationLongitude,
      destinationAddress: group.destinationAddress,
      fromZoneKey: group.fromZoneKey,
      toZoneKey: group.toZoneKey,
      groupFareRuleId: group.groupFareRuleId,
      capacity: group.capacity,
      joinedMemberCount: group.joinedMemberCount,
      status: groupStatusLabel(group.status),
      fareAmount: money(group.fareAmount),
      commissionRate: money(group.commissionRate),
      commissionAmount: money(group.commissionAmount),
      captainEarnings: money(group.captainEarnings),
      totalAmount: money(group.totalAmount),
      paymentMethod: group.paymentMethod,
      isCashConfirmed: group.isCashConfirmed,
      membershipLocked: group.membershipLocked,
      driverId: group.driverId,
      driverName: group.driver?.user.fullName ?? null,
      confirmedAt: group.confirmedAt,
      assignedAt: group.assignedAt,
      startedAt: group.startedAt,
      completedAt: group.completedAt,
      cancelledAt: group.cancelledAt,
      referenceCode: group.referenceCode,
      createdAt: group.createdAt,
      members: group.members
        .filter((m) => !m.isDeleted)
        .map((m) => ({
          userId: m.userId,
          displayName: m.user.fullName,
          isOrganizer: m.isOrganizer,
          joinedAt: m.joinedAt,
        })),
      distanceKm: group.distanceKm == null ? null : money(group.distanceKm),
    };
  }
}

const groupInclude = {
  driver: { include: { user: true } },
  members: { include: { user: true } },
} satisfies Prisma.GroupRequestInclude;

type GroupRow = Prisma.GroupRequestGetPayload<{ include: typeof groupInclude }>;

function trimOrNull(value?: string | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}
