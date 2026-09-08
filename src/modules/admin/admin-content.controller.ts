import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { PrismaService } from '../../database/prisma/prisma.service';
import { NotFoundException } from '../../common/exceptions/app.exception';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { money, splitEarnings } from '../../common/utils/money';
import { parseVehicleType, vehicleTypeLabel } from '../../common/utils/enums-map';
import { BookingStatus } from '../../common/enums';

@ApiTags('admin-faq')
@AdminOnly()
@Controller('api/v1/admin/faq')
export class AdminFaqController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const items = await this.prisma.faqItem.findMany({
      where: { isDeleted: false },
      orderBy: { order: 'asc' },
    });
    return ApiResponse.ok(items);
  }

  @Post()
  async create(@Body() body: SaveFaq) {
    const item = await this.prisma.faqItem.create({
      data: { id: newId(), ...body, isActive: body.isActive ?? true, ...baseFields() },
    });
    return ApiResponse.ok(item, 'تمت الإضافة');
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SaveFaq) {
    await this.requireFaq(id);
    const item = await this.prisma.faqItem.update({
      where: { id },
      data: { ...body, isActive: body.isActive ?? true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(item, 'تم التحديث');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.requireFaq(id);
    await this.prisma.faqItem.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم الحذف');
  }

  private async requireFaq(id: string) {
    const item = await this.prisma.faqItem.findFirst({
      where: { id, isDeleted: false },
    });
    if (!item) {
      throw new NotFoundException('العنصر غير موجود');
    }
  }
}

@ApiTags('admin-legal')
@AdminOnly()
@Controller('api/v1/admin/legal')
export class AdminLegalController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const items = await this.prisma.legalDocument.findMany({
      where: { isDeleted: false },
      orderBy: { slug: 'asc' },
    });
    return ApiResponse.ok(items);
  }

  @Post()
  async create(@Body() body: SaveLegal) {
    const item = await this.prisma.legalDocument.create({
      data: { id: newId(), ...body, isActive: body.isActive ?? true, ...baseFields() },
    });
    return ApiResponse.ok(item, 'تمت الإضافة');
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SaveLegal) {
    const existing = await this.prisma.legalDocument.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('المستند غير موجود');
    }
    const item = await this.prisma.legalDocument.update({
      where: { id },
      data: { ...body, isActive: body.isActive ?? true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(item, 'تم التحديث');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.legalDocument.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('المستند غير موجود');
    }
    await this.prisma.legalDocument.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم الحذف');
  }
}

@ApiTags('admin-packages')
@AdminOnly()
@Controller('api/v1/admin/packages')
export class AdminPackagesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const items = await this.prisma.subscriptionPackage.findMany({
      where: { isDeleted: false },
      orderBy: { price: 'asc' },
    });
    return ApiResponse.ok(
      items.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: money(p.price),
        tripCount: p.tripCount,
        validityDays: p.validityDays,
        isActive: p.isActive,
      })),
    );
  }

  @Post()
  async create(@Body() body: SavePackage) {
    const item = await this.prisma.subscriptionPackage.create({
      data: {
        id: newId(),
        name: body.name,
        description: body.description,
        price: new Prisma.Decimal(body.price),
        tripCount: body.tripCount,
        validityDays: body.validityDays,
        isActive: body.isActive ?? true,
        ...baseFields(),
      },
    });
    return ApiResponse.ok(
      { ...item, price: money(item.price) },
      'تمت الإضافة',
    );
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SavePackage) {
    const existing = await this.prisma.subscriptionPackage.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('الباقة غير موجودة');
    }
    const item = await this.prisma.subscriptionPackage.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        price: new Prisma.Decimal(body.price),
        tripCount: body.tripCount,
        validityDays: body.validityDays,
        isActive: body.isActive ?? true,
        updatedAt: utcNow(),
      },
    });
    return ApiResponse.ok({ ...item, price: money(item.price) }, 'تم التحديث');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.subscriptionPackage.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('الباقة غير موجودة');
    }
    await this.prisma.subscriptionPackage.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم الحذف');
  }
}

@ApiTags('admin-commission-rules')
@AdminOnly()
@Controller('api/v1/admin/commission-rules')
export class AdminCommissionController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const items = await this.prisma.commissionRule.findMany({
      where: { isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(
      items.map((r) => ({
        ...r,
        platformCommissionPercent: money(r.platformCommissionPercent),
      })),
    );
  }

  @Post()
  async create(@Body() body: SaveCommission) {
    const item = await this.prisma.commissionRule.create({
      data: {
        id: newId(),
        name: body.name,
        platformCommissionPercent: new Prisma.Decimal(body.platformCommissionPercent),
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
        effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
        isActive: body.isActive ?? true,
        ...baseFields(),
      },
    });
    return ApiResponse.ok(
      { ...item, platformCommissionPercent: money(item.platformCommissionPercent) },
      'تمت الإضافة',
    );
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SaveCommission) {
    const existing = await this.prisma.commissionRule.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('القاعدة غير موجودة');
    }
    const item = await this.prisma.commissionRule.update({
      where: { id },
      data: {
        name: body.name,
        platformCommissionPercent: new Prisma.Decimal(body.platformCommissionPercent),
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
        effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
        isActive: body.isActive ?? true,
        updatedAt: utcNow(),
      },
    });
    return ApiResponse.ok(
      { ...item, platformCommissionPercent: money(item.platformCommissionPercent) },
      'تم التحديث',
    );
  }
}

@ApiTags('admin-pricing-rules')
@AdminOnly()
@Controller('api/v1/admin/pricing-rules')
export class AdminPricingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('routeId') routeId?: string,
    @Query('vehicleType') vehicleType?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const items = await this.prisma.pricingRule.findMany({
      where: {
        isDeleted: false,
        ...(routeId ? { routeId } : {}),
        ...(vehicleType ? { vehicleType: parseVehicleType(vehicleType) } : {}),
        ...(activeOnly === 'true' ? { isActive: true } : {}),
      },
      include: { route: true },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(items.map(mapPricing));
  }

  @Post()
  async create(@Body() body: SavePricing) {
    const item = await this.prisma.pricingRule.create({
      data: { id: newId(), ...pricingData(body), ...baseFields() },
      include: { route: true },
    });
    return ApiResponse.ok(mapPricing(item), 'تمت الإضافة');
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: SavePricing) {
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('القاعدة غير موجودة');
    }
    const item = await this.prisma.pricingRule.update({
      where: { id },
      data: { ...pricingData(body), updatedAt: utcNow() },
      include: { route: true },
    });
    return ApiResponse.ok(mapPricing(item), 'تم التحديث');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, isDeleted: false },
    });
    if (!existing) {
      throw new NotFoundException('القاعدة غير موجودة');
    }
    await this.prisma.pricingRule.update({
      where: { id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم الحذف');
  }

  @Post('preview')
  async preview(
    @Body()
    body: {
      routeId?: string;
      vehicleType: string;
      passengerCount: number;
      tripType: string;
      capacity?: number;
    },
  ) {
    const vehicleType = parseVehicleType(body.vehicleType);
    const rule = await this.prisma.pricingRule.findFirst({
      where: {
        isDeleted: false,
        isActive: true,
        vehicleType,
        ...(body.routeId ? { routeId: body.routeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const unit =
      body.tripType === 'roundTrip'
        ? money(rule?.roundTripPrice ?? 0)
        : body.tripType === 'weekly'
          ? money(rule?.weeklyPrice ?? 0)
          : body.tripType === 'monthly'
            ? money(rule?.monthlyPrice ?? 0)
            : money(rule?.oneWayPrice ?? 0);
    const gross = unit * body.passengerCount;
    const percent = money(rule?.permanentCommissionPercent ?? 0);
    const split = splitEarnings(gross, percent);
    const capacity = body.capacity ?? 1;
    return ApiResponse.ok({
      pricingRuleId: rule?.id ?? null,
      vehicleType: vehicleTypeLabel(vehicleType),
      tripType: body.tripType,
      passengerCount: body.passengerCount,
      unitPrice: unit,
      grossRevenue: gross,
      commissionPercent: percent,
      commissionAmount: split.commissionAmount,
      captainEarnings: split.captainEarnings,
      occupancyPercent: capacity > 0 ? (body.passengerCount / capacity) * 100 : 0,
      minimumLaunchRiders: rule?.minimumLaunchRiders ?? null,
      targetOccupancy: rule?.targetOccupancy ?? null,
    });
  }
}

@ApiTags('admin-earnings')
@AdminOnly()
@Controller('api/v1/admin/earnings')
export class AdminEarningsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('trips')
  async trips(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('driverId') driverId?: string,
    @Query('routeId') routeId?: string,
  ) {
    const bookings = await this.prisma.booking.findMany({
      where: {
        isDeleted: false,
        status: BookingStatus.Confirmed,
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
        trip: {
          isDeleted: false,
          ...(driverId ? { driverId } : {}),
          ...(routeId ? { routeId } : {}),
        },
      },
    });
    const revenue = bookings.reduce((s, b) => s + money(b.totalAmount), 0);
    const captain = bookings.reduce((s, b) => s + money(b.captainEarnings), 0);
    const commission = bookings.reduce((s, b) => s + money(b.commissionAmount), 0);
    return ApiResponse.ok({
      bookingCount: bookings.length,
      grossRevenue: revenue,
      captainEarnings: captain,
      platformCommission: commission,
    });
  }
}

type SaveFaq = { question: string; answer: string; order: number; isActive?: boolean };
type SaveLegal = {
  slug: string;
  title: string;
  content: string;
  titleEn?: string;
  contentEn?: string;
  isActive?: boolean;
};
type SavePackage = {
  name: string;
  description?: string;
  price: number;
  tripCount: number;
  validityDays: number;
  isActive?: boolean;
};
type SaveCommission = {
  name: string;
  platformCommissionPercent: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  isActive?: boolean;
};
type SavePricing = {
  name: string;
  routeId?: string;
  vehicleType: string;
  oneWayPrice: number;
  roundTripPrice: number;
  weeklyPrice: number;
  monthlyPrice: number;
  launchCommissionPercent: number;
  permanentCommissionPercent: number;
  launchPeriodDays: number;
  launchStartAt?: string;
  minimumLaunchRiders: number;
  targetOccupancy: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  isActive?: boolean;
};

function pricingData(body: SavePricing) {
  return {
    name: body.name,
    routeId: body.routeId,
    vehicleType: parseVehicleType(body.vehicleType),
    oneWayPrice: new Prisma.Decimal(body.oneWayPrice),
    roundTripPrice: new Prisma.Decimal(body.roundTripPrice),
    weeklyPrice: new Prisma.Decimal(body.weeklyPrice),
    monthlyPrice: new Prisma.Decimal(body.monthlyPrice),
    launchCommissionPercent: new Prisma.Decimal(body.launchCommissionPercent),
    permanentCommissionPercent: new Prisma.Decimal(body.permanentCommissionPercent),
    launchPeriodDays: body.launchPeriodDays,
    launchStartAt: body.launchStartAt ? new Date(body.launchStartAt) : null,
    minimumLaunchRiders: body.minimumLaunchRiders,
    targetOccupancy: body.targetOccupancy,
    effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
    effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
    isActive: body.isActive ?? true,
  };
}

function mapPricing(r: {
  id: string;
  name: string;
  routeId: string | null;
  route?: { name: string } | null;
  vehicleType: number;
  oneWayPrice: Prisma.Decimal;
  roundTripPrice: Prisma.Decimal;
  weeklyPrice: Prisma.Decimal;
  monthlyPrice: Prisma.Decimal;
  launchCommissionPercent: Prisma.Decimal;
  permanentCommissionPercent: Prisma.Decimal;
  launchPeriodDays: number;
  launchStartAt: Date | null;
  minimumLaunchRiders: number;
  targetOccupancy: number;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  isActive: boolean;
}) {
  return {
    id: r.id,
    name: r.name,
    routeId: r.routeId,
    routeName: r.route?.name ?? null,
    vehicleType: vehicleTypeLabel(r.vehicleType),
    oneWayPrice: money(r.oneWayPrice),
    roundTripPrice: money(r.roundTripPrice),
    weeklyPrice: money(r.weeklyPrice),
    monthlyPrice: money(r.monthlyPrice),
    launchCommissionPercent: money(r.launchCommissionPercent),
    permanentCommissionPercent: money(r.permanentCommissionPercent),
    launchPeriodDays: r.launchPeriodDays,
    launchStartAt: r.launchStartAt,
    minimumLaunchRiders: r.minimumLaunchRiders,
    targetOccupancy: r.targetOccupancy,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isActive: r.isActive,
  };
}
