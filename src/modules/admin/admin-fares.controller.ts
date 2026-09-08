import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { PrismaService } from '../../database/prisma/prisma.service';
import { NotFoundException } from '../../common/exceptions/app.exception';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { money } from '../../common/utils/money';

@ApiTags('admin-ride-fare-rules')
@AdminOnly()
@Controller('api/v1/admin/ride-fare-rules')
export class AdminRideFareController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query('activeOnly') activeOnly?: string) {
    const items = await this.prisma.rideFareRule.findMany({
      where: {
        isDeleted: false,
        ...(activeOnly === 'true' ? { isActive: true } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(items.map(mapRideFare));
  }

  @Post()
  async create(@Body() body: SaveRideFare) {
    const item = await this.prisma.rideFareRule.create({
      data: { id: newId(), ...rideFareData(body), ...baseFields() },
    });
    return ApiResponse.ok(mapRideFare(item), 'تمت الإضافة');
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SaveRideFare) {
    await this.require(id);
    const item = await this.prisma.rideFareRule.update({
      where: { id },
      data: { ...rideFareData(body), updatedAt: utcNow() },
    });
    return ApiResponse.ok(mapRideFare(item), 'تم التحديث');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.require(id);
    await this.prisma.rideFareRule.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم الحذف');
  }

  private async require(id: string) {
    const item = await this.prisma.rideFareRule.findFirst({
      where: { id, isDeleted: false },
    });
    if (!item) {
      throw new NotFoundException('القاعدة غير موجودة');
    }
  }
}

@ApiTags('admin-group-fare-rules')
@AdminOnly()
@Controller('api/v1/admin/group-fare-rules')
export class AdminGroupFareController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query('activeOnly') activeOnly?: string) {
    const items = await this.prisma.groupFareRule.findMany({
      where: {
        isDeleted: false,
        ...(activeOnly === 'true' ? { isActive: true } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(items.map(mapGroupFare));
  }

  @Post()
  async create(@Body() body: SaveGroupFare) {
    const item = await this.prisma.groupFareRule.create({
      data: { id: newId(), ...groupFareData(body), ...baseFields() },
    });
    return ApiResponse.ok(mapGroupFare(item), 'تمت الإضافة');
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SaveGroupFare) {
    const existing = await this.prisma.groupFareRule.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('القاعدة غير موجودة');
    }
    const item = await this.prisma.groupFareRule.update({
      where: { id },
      data: { ...groupFareData(body), updatedAt: utcNow() },
    });
    return ApiResponse.ok(mapGroupFare(item), 'تم التحديث');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.groupFareRule.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('القاعدة غير موجودة');
    }
    await this.prisma.groupFareRule.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم الحذف');
  }
}

type SaveRideFare = {
  name: string;
  fromZoneKey?: string;
  toZoneKey?: string;
  flatFare: number;
  baseFare?: number;
  pricePerKm?: number;
  minimumFare?: number;
  maximumFare?: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  isActive?: boolean;
};

type SaveGroupFare = SaveRideFare & {
  charterFlatFare: number;
  maxMembers: number;
};

function rideFareData(body: SaveRideFare) {
  return {
    name: body.name,
    fromZoneKey: body.fromZoneKey,
    toZoneKey: body.toZoneKey,
    flatFare: new Prisma.Decimal(body.flatFare),
    baseFare: new Prisma.Decimal(body.baseFare ?? 0),
    pricePerKm: new Prisma.Decimal(body.pricePerKm ?? 0),
    minimumFare: body.minimumFare == null ? null : new Prisma.Decimal(body.minimumFare),
    maximumFare: body.maximumFare == null ? null : new Prisma.Decimal(body.maximumFare),
    effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
    effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
    isActive: body.isActive ?? true,
  };
}

function groupFareData(body: SaveGroupFare) {
  return {
    name: body.name,
    fromZoneKey: body.fromZoneKey,
    toZoneKey: body.toZoneKey,
    charterFlatFare: new Prisma.Decimal(body.charterFlatFare),
    maxMembers: body.maxMembers,
    baseFare: new Prisma.Decimal(body.baseFare ?? 0),
    pricePerKm: new Prisma.Decimal(body.pricePerKm ?? 0),
    minimumFare: body.minimumFare == null ? null : new Prisma.Decimal(body.minimumFare),
    maximumFare: body.maximumFare == null ? null : new Prisma.Decimal(body.maximumFare),
    effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
    effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
    isActive: body.isActive ?? true,
  };
}

function mapRideFare(r: {
  id: string;
  name: string;
  fromZoneKey: string | null;
  toZoneKey: string | null;
  flatFare: Prisma.Decimal;
  baseFare: Prisma.Decimal;
  pricePerKm: Prisma.Decimal;
  minimumFare: Prisma.Decimal | null;
  maximumFare: Prisma.Decimal | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}) {
  return {
    id: r.id,
    name: r.name,
    fromZoneKey: r.fromZoneKey,
    toZoneKey: r.toZoneKey,
    flatFare: money(r.flatFare),
    baseFare: money(r.baseFare),
    pricePerKm: money(r.pricePerKm),
    minimumFare: r.minimumFare == null ? null : money(r.minimumFare),
    maximumFare: r.maximumFare == null ? null : money(r.maximumFare),
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mapGroupFare(r: {
  id: string;
  name: string;
  fromZoneKey: string | null;
  toZoneKey: string | null;
  charterFlatFare: Prisma.Decimal;
  baseFare: Prisma.Decimal;
  pricePerKm: Prisma.Decimal;
  minimumFare: Prisma.Decimal | null;
  maximumFare: Prisma.Decimal | null;
  maxMembers: number;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}) {
  return {
    id: r.id,
    name: r.name,
    fromZoneKey: r.fromZoneKey,
    toZoneKey: r.toZoneKey,
    charterFlatFare: money(r.charterFlatFare),
    baseFare: money(r.baseFare),
    pricePerKm: money(r.pricePerKm),
    minimumFare: r.minimumFare == null ? null : money(r.minimumFare),
    maximumFare: r.maximumFare == null ? null : money(r.maximumFare),
    maxMembers: r.maxMembers,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
