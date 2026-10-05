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
import { isSelfOwnedTrip } from '../marketplace/self-booking';
import { GroupGateway } from '../realtime/realtime.gateway';

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
    private readonly groupHub: GroupGateway,
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
          pickupLatitude: body.pickupLatitude,
          pickupLongitude: body.pickupLongitude,
          pickupAddress: trimOrNull(body.pickupAddress),
          joinedAt: utcNow(),
          ...baseFields(),
        },
      }),
    ]);
    return this.byId(id);
  }

  async join(groupId: string, body?: GroupPickupInput) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    if (group.driverId) {
      const driver = await this.prisma.driver.findFirst({
        where: { id: group.driverId, isDeleted: false },
        select: { userId: true },
      });
      if (driver && isSelfOwnedTrip(userId, null, driver.userId)) {
        throw new AppException(
          'لا يمكنك حجز رحلتك',
          400,
          ErrorCodes.SelfBookingNotAllowed,
        );
      }
    }
    const pickup = pickupFields(body);
    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.groupRequest.findFirst({
          where: { id: group.id, isDeleted: false },
        });
        if (
          !current ||
          current.membershipLocked ||
          current.status !== GroupRequestStatus.Draft
        ) {
          throw new AppException(
            'لا يمكن الانضمام لهذه المجموعة',
            400,
            ErrorCodes.GroupMembershipLocked,
          );
        }

        const already = await tx.groupMember.findFirst({
          where: {
            groupRequestId: group.id,
            userId,
            isDeleted: false,
          },
        });
        if (already) {
          if (pickup) {
            await tx.groupMember.update({
              where: { id: already.id },
              data: pickup,
            });
            return;
          }
          throw new AppException(
            'أنت عضو بالفعل في هذه المجموعة',
            400,
            ErrorCodes.GroupDuplicateMember,
          );
        }

        const claimed = await tx.groupRequest.updateMany({
          where: {
            id: group.id,
            isDeleted: false,
            status: GroupRequestStatus.Draft,
            membershipLocked: false,
            joinedMemberCount: { lt: current.capacity },
          },
          data: {
            joinedMemberCount: { increment: 1 },
            updatedAt: utcNow(),
          },
        });
        if (claimed.count !== 1) {
          throw new AppException(
            'المجموعة ممتلئة',
            400,
            ErrorCodes.GroupCapacityExceeded,
          );
        }

        await tx.groupMember.create({
          data: {
            id: newId(),
            groupRequestId: group.id,
            userId,
            isOrganizer: false,
            joinedAt: utcNow(),
            ...baseFields(),
            ...(pickup ?? {}),
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppException(
          'أنت عضو بالفعل في هذه المجموعة',
          400,
          ErrorCodes.GroupDuplicateMember,
        );
      }
      throw error;
    }
    return this.broadcast(group.id);
  }

  async setPickup(groupId: string, body?: GroupPickupInput) {
    const userId = this.currentUser.requireUserId();
    const pickup = pickupFields(body);
    if (!pickup) {
      throw new AppException('نقطة الانطلاق غير صالحة', 400, ErrorCodes.TripCoordinatesRequired);
    }
    const group = await this.requireGroup(groupId);
    if (
      group.status === GroupRequestStatus.Completed ||
      group.status === GroupRequestStatus.Cancelled
    ) {
      throw new AppException(
        'لا يمكن تعديل نقطة الانطلاق لهذه الرحلة',
        400,
        ErrorCodes.GroupMembershipLocked,
      );
    }
    const member = group.members.find((m) => m.userId === userId && !m.isDeleted);
    if (!member) {
      throw new AppException('لست عضواً في المجموعة', 400, ErrorCodes.GroupNotMember);
    }
    await this.prisma.groupMember.update({
      where: { id: member.id },
      data: pickup,
    });
    return this.broadcast(group.id);
  }

  async listMemberMessages(groupId: string, peerUserId: string) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    const peer = this.assertChatPair(group, userId, peerUserId);
    const rows = await this.prisma.groupMemberMessage.findMany({
      where: {
        groupRequestId: group.id,
        isDeleted: false,
        OR: [
          { senderUserId: userId, recipientUserId: peer },
          { senderUserId: peer, recipientUserId: userId },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map(mapMemberMessage);
  }

  async sendMemberMessage(
    groupId: string,
    body?: { peerUserId?: string; body?: string },
  ) {
    const userId = this.currentUser.requireUserId();
    const text = body?.body?.trim() ?? '';
    if (!text || text.length > 2000) {
      throw new AppException('الرسالة غير صالحة', 400, ErrorCodes.GroupNotMember);
    }
    const group = await this.requireGroup(groupId);
    const peer = this.assertChatPair(group, userId, body?.peerUserId ?? '');
    const row = await this.prisma.groupMemberMessage.create({
      data: {
        id: newId(),
        groupRequestId: group.id,
        senderUserId: userId,
        recipientUserId: peer,
        body: text,
        ...baseFields(),
      },
    });
    const message = mapMemberMessage(row);
    this.groupHub.publishChat(message);
    return message;
  }

  async unreadMemberMessages(groupId: string) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    this.assertChatMember(group, userId);
    const rows = await this.prisma.groupMemberMessage.groupBy({
      by: ['senderUserId'],
      where: {
        groupRequestId: group.id,
        recipientUserId: userId,
        isDeleted: false,
        readAt: null,
      },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      peerUserId: row.senderUserId,
      count: row._count._all,
    }));
  }

  async markMemberMessagesRead(groupId: string, peerUserId: string) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    const peer = this.assertChatPair(group, userId, peerUserId);
    await this.prisma.groupMemberMessage.updateMany({
      where: {
        groupRequestId: group.id,
        senderUserId: peer,
        recipientUserId: userId,
        isDeleted: false,
        readAt: null,
      },
      data: { readAt: utcNow(), updatedAt: utcNow() },
    });
    this.groupHub.publishChatRead({
      groupId: group.id,
      readerUserId: userId,
      peerUserId: peer,
    });
    return { peerUserId: peer, count: 0 };
  }

  private readonly typingUntil = new Map<string, number>();

  async notifyMemberTyping(groupId: string, peerUserId: string, typing: boolean) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    const peer = this.assertChatPair(group, userId, peerUserId);
    const key = `${group.id}:${userId}:${peer}`;
    if (typing) this.typingUntil.set(key, Date.now() + 3000);
    else this.typingUntil.delete(key);
    this.groupHub.publishTyping({
      groupId: group.id,
      senderUserId: userId,
      peerUserId: peer,
      typing,
    });
    return { typing };
  }

  async memberTypingPeers(groupId: string) {
    const userId = this.currentUser.requireUserId();
    const group = await this.requireGroup(groupId);
    this.assertChatMember(group, userId);
    const now = Date.now();
    return group.members
      .filter((member) => !member.isDeleted && member.userId !== userId)
      .filter(
        (member) =>
          (this.typingUntil.get(`${group.id}:${member.userId}:${userId}`) ?? 0) > now,
      )
      .map((member) => ({ peerUserId: member.userId }));
  }

  private assertChatPair(group: GroupRow, userId: string, peerUserId: string) {
    const peer = peerUserId.trim();
    if (!isGroupUuid(peer) || peer === userId) {
      throw new AppException('لا يمكن فتح هذه المحادثة', 400, ErrorCodes.GroupNotMember);
    }
    const members = new Set(
      group.members.filter((member) => !member.isDeleted).map((member) => member.userId),
    );
    if (!members.has(userId) || !members.has(peer)) {
      throw new AppException('لست عضواً في المجموعة', 400, ErrorCodes.GroupNotMember);
    }
    return peer;
  }

  private assertChatMember(group: GroupRow, userId: string) {
    const members = new Set(
      group.members.filter((member) => !member.isDeleted).map((member) => member.userId),
    );
    if (!members.has(userId)) {
      throw new AppException('لست عضواً في المجموعة', 400, ErrorCodes.GroupNotMember);
    }
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
        where: { id: group.id },
        data: { joinedMemberCount: { decrement: 1 }, updatedAt: utcNow() },
      }),
    ]);
    return this.broadcast(group.id);
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
      where: { id: group.id },
      data: {
        status: GroupRequestStatus.Confirmed,
        isCashConfirmed: true,
        membershipLocked: true,
        confirmedAt: utcNow(),
        updatedAt: utcNow(),
      },
    });
    return this.broadcast(group.id);
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

  async publishGroup(groupId: string) {
    return this.broadcast(groupId);
  }

  private async broadcast(groupId: string) {
    const group = await this.requireGroup(groupId);
    const mapped = this.mapGroup(group);
    this.groupHub.publish(mapped);
    return mapped;
  }

  async invite(code: string) {
    this.currentUser.requireUserId();
    const cleaned = code.trim();
    if (!/^GR-\d{8}-\d{4}$/.test(cleaned)) {
      throw new NotFoundException('المجموعة غير موجودة', ErrorCodes.GroupNotFound);
    }
    const group = await this.requireGroup(cleaned);
    return this.mapGroup(group);
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
      where: { id: group.id },
      data: {
        status: GroupRequestStatus.Cancelled,
        cancelledAt: utcNow(),
        updatedAt: utcNow(),
      },
    });
    return this.broadcast(group.id);
  }

  private async requireGroup(idOrCode: string) {
    const key = idOrCode.trim();
    const group = await this.prisma.groupRequest.findFirst({
      where: {
        isDeleted: false,
        ...(isGroupUuid(key) ? { id: key } : { referenceCode: key }),
      },
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
      driverPhone: group.driver?.user.phone ?? null,
      driverAvatarUrl: group.driver?.user.avatarUrl ?? null,
      driverRatingAverage: driverRating(group.driver),
      driverRatingCount: driverRatingCount(group.driver),
      driverVehicleKind: firstText(group.driver?.vehicleKind),
      driverVehicleModel: firstText(group.driver?.vehicleModelName),
      driverVehicleColor: firstText(group.driver?.vehicleColor),
      driverPlate: firstText(group.driver?.plateNumber),
      confirmedAt: group.confirmedAt,
      assignedAt: group.assignedAt,
      startedAt: group.startedAt,
      completedAt: group.completedAt,
      cancelledAt: group.cancelledAt,
      referenceCode: group.referenceCode,
      createdAt: group.createdAt,
      members: group.members
        .filter((m) => !m.isDeleted)
        .slice()
        .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
        .map((m) => ({
          userId: m.userId,
          displayName: m.user.fullName,
          isOrganizer: m.isOrganizer,
          joinedAt: m.joinedAt,
          phone: m.user.phone,
          avatarUrl: m.user.avatarUrl,
          ratingAverage: Number(m.user.ratingAverage),
          ratingCount: m.user.ratingCount,
          pickupLatitude: m.pickupLatitude,
          pickupLongitude: m.pickupLongitude,
          pickupAddress: m.pickupAddress,
        })),
      distanceKm: group.distanceKm == null ? null : money(group.distanceKm),
    };
  }
}

function mapMemberMessage(row: {
  id: string;
  groupRequestId: string;
  senderUserId: string;
  recipientUserId: string;
  body: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    groupId: row.groupRequestId,
    senderUserId: row.senderUserId,
    recipientUserId: row.recipientUserId,
    body: row.body,
    createdAt: row.createdAt,
  };
}

function isGroupUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

const groupInclude = {
  driver: { include: { user: true } },
  members: { include: { user: true } },
} satisfies Prisma.GroupRequestInclude;

type GroupRow = Prisma.GroupRequestGetPayload<{ include: typeof groupInclude }>;

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function driverRating(
  driver: GroupRow['driver'],
): number | null {
  if (!driver) return null;
  const count = driver.ratingCount ?? 0;
  if (count > 0) return Number(driver.ratingAverage);
  if ((driver.user.ratingCount ?? 0) > 0) return Number(driver.user.ratingAverage);
  return Number(driver.ratingAverage);
}

function driverRatingCount(driver: GroupRow['driver']): number | null {
  if (!driver) return null;
  if ((driver.ratingCount ?? 0) > 0) return driver.ratingCount;
  return driver.user.ratingCount ?? 0;
}

function trimOrNull(value?: string | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}

type GroupPickupInput = {
  pickupLatitude?: number;
  pickupLongitude?: number;
  pickupAddress?: string;
};

function pickupFields(body?: GroupPickupInput) {
  const lat = Number(body?.pickupLatitude);
  const lng = Number(body?.pickupLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    pickupLatitude: lat,
    pickupLongitude: lng,
    pickupAddress: trimOrNull(body?.pickupAddress),
    updatedAt: utcNow(),
  };
}
