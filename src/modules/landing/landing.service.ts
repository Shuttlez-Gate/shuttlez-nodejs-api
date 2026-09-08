import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AppException } from '../../common/exceptions/app.exception';
import { DriverVerificationStatus, UserType } from '../../common/enums';
import { normalizePhone } from '../../common/utils/phone-normalizer';
import { newId, utcNow } from '../../common/utils/date.util';
import {
  baseFields,
  driverDefaults,
  userDefaults,
  walletDefaults,
} from '../../common/utils/entity-defaults';
import { EgyptRouteLocations } from './egypt-route-locations';

const usageDaysAr = [
  'السبت - الخميس',
  'السبت - الأربعاء',
  'الأحد - الخميس',
  'يومي (عدا الجمعة)',
  'عطلة نهاية الأسبوع فقط',
];
const usageDaysEn = [
  'Saturday - Thursday',
  'Saturday - Wednesday',
  'Sunday - Thursday',
  'Daily (except Friday)',
  'Weekends only',
];
const usageReasonsAr = ['العمل', 'الدراسة', 'مواعيد شخصية', 'تسوق', 'أخرى'];
const usageReasonsEn = ['Work', 'Study', 'Personal appointments', 'Shopping', 'Other'];

@Injectable()
export class LandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  getRouteOptions(language?: string | null) {
    const english = EgyptRouteLocations.isEnglish(language);
    return {
      cities: EgyptRouteLocations.cities(language),
      regionsByCity: EgyptRouteLocations.regionsByCity(language),
      areasByRegion: EgyptRouteLocations.areasByRegion(language),
      usageDayOptions: english ? usageDaysEn : usageDaysAr,
      usageReasonOptions: english ? usageReasonsEn : usageReasonsAr,
    };
  }

  async submitRouteLead(form: {
    phone: string;
    fromCity: string;
    fromRegion: string;
    fromTime?: string;
    toCity: string;
    toRegion: string;
    toTime?: string;
    weeklyCount: number;
    usageDays?: string;
    usageReason?: string;
  }) {
    validateLandingPhone(form.phone);
    if (
      !form.fromCity?.trim() ||
      !form.fromRegion?.trim() ||
      !form.toCity?.trim() ||
      !form.toRegion?.trim()
    ) {
      throw new AppException('يرجى إكمال بيانات المسار');
    }
    const entity = await this.prisma.landingRouteLead.create({
      data: {
        id: newId(),
        phone: digitsOnly(form.phone),
        fromCity: form.fromCity.trim(),
        fromRegion: form.fromRegion.trim(),
        fromTime: form.fromTime,
        toCity: form.toCity.trim(),
        toRegion: form.toRegion.trim(),
        toTime: form.toTime,
        weeklyCount: form.weeklyCount <= 0 ? 5 : form.weeklyCount,
        usageDays: form.usageDays,
        usageReason: form.usageReason,
        source: 'landing',
        ...baseFields(),
      },
    });
    return {
      id: entity.id,
      message: 'تم تسجيل طلبك بنجاح. سنتواصل معك قريباً.',
    };
  }

  async submitWaitlist(form: {
    phone: string;
    fullName?: string;
    routeId?: string | null;
    routeFrom?: string;
    routeTo?: string;
  }) {
    validateLandingPhone(form.phone);
    const phone = digitsOnly(form.phone);

    let routeFrom = form.routeFrom?.trim();
    let routeTo = form.routeTo?.trim();
    if (form.routeId) {
      const route = await this.prisma.route.findFirst({
        where: { id: form.routeId, isActive: true, isDeleted: false },
      });
      if (!route) {
        throw new AppException('المسار غير موجود');
      }
      const exists = await this.prisma.landingWaitlistEntry.findFirst({
        where: { phone, routeId: form.routeId },
      });
      if (exists) {
        throw new AppException('رقمك مسجل بالفعل في قائمة انتظار هذا المسار');
      }
      const split = splitRouteName(route.name);
      routeFrom = form.routeFrom?.trim() ?? split.from;
      routeTo = form.routeTo?.trim() ?? split.to;
    } else {
      const exists = await this.prisma.landingWaitlistEntry.findFirst({
        where: { phone, routeId: null },
      });
      if (exists) {
        throw new AppException('رقمك مسجل بالفعل في قائمة الانتظار');
      }
    }

    const entity = await this.prisma.landingWaitlistEntry.create({
      data: {
        id: newId(),
        phone,
        fullName: form.fullName?.trim(),
        routeId: form.routeId ?? null,
        routeFrom,
        routeTo,
        source: form.routeId ? 'routes-page' : 'landing',
        ...baseFields(),
      },
    });
    return {
      id: entity.id,
      message: form.routeId
        ? 'تم تسجيلك في قائمة انتظار المسار بنجاح'
        : 'تم انضمامك لقائمة الانتظار بنجاح',
    };
  }

  async submitCaptain(form: {
    phone: string;
    fullName?: string;
    vehicleType?: string;
    notes?: string;
  }) {
    validateLandingPhone(form.phone);
    const phone = normalizePhone(form.phone);
    const entity = await this.prisma.landingCaptainLead.create({
      data: {
        id: newId(),
        phone,
        fullName: form.fullName?.trim(),
        vehicleType: form.vehicleType?.trim(),
        notes: form.notes?.trim(),
        source: 'landing',
        ...baseFields(),
      },
    });
    await this.ensureDriver(phone, entity.fullName);
    return {
      id: entity.id,
      message: 'تم استلام طلب التسجيل ككابتن. سنتواصل معك قريباً',
    };
  }

  async getConfig() {
    const waitlistCount = await this.prisma.landingWaitlistEntry.count({
      where: { isDeleted: false },
    });
    const captainCount = await this.prisma.landingCaptainLead.count({
      where: { isDeleted: false },
    });
    const totalSlots = Number(this.config.get('CAPTAIN_LAUNCH_TOTAL_SLOTS') ?? 500);
    return {
      vehicleOptions: [
        { value: 'car', labelAr: 'سيارة', labelEn: 'Car' },
        { value: 'minibus', labelAr: 'ميكروباص', labelEn: 'Minibus' },
        { value: 'bus', labelAr: 'أوتوبيس', labelEn: 'Bus' },
      ],
      waitlistSuccessMessage: 'تم انضمامك لقائمة الانتظار بنجاح',
      captainSuccessMessage: 'تم استلام طلب التسجيل ككابتن. سنتواصل معك قريباً',
      routeRequestSuccessMessage: 'تم تسجيل طلبك بنجاح. سنتواصل معك قريباً.',
      waitlistCount,
      captainOffer: {
        totalSlots,
        registeredCount: captainCount,
        remainingSlots: Math.max(totalSlots - captainCount, 0),
        profitPercent: Number(this.config.get('CAPTAIN_LAUNCH_PROFIT_PERCENT') ?? 100),
        firstTrips: Number(this.config.get('CAPTAIN_LAUNCH_FIRST_TRIPS') ?? 100),
        durationMonths: Number(this.config.get('CAPTAIN_LAUNCH_DURATION_MONTHS') ?? 3),
      },
    };
  }

  async getLandingRoutes() {
    const routes = await this.prisma.route.findMany({
      where: { isActive: true, isDeleted: false },
      orderBy: { name: 'asc' },
      include: { stops: { where: { isDeleted: false } } },
    });
    return routes.map((route) => {
      const { from, to } = splitRouteName(route.name);
      return {
        id: route.id,
        from,
        to,
        stopsCount: route.stops.length,
        lineCode: '',
        badgeTone: 'green',
        nearestStreet: route.stops[0]?.name ?? from,
        meetingPoint: 'أقرب نقطة التقاء - 10دق',
        waitlistCount: 0,
      };
    });
  }

  private async ensureDriver(phone: string, fullName: string | null) {
    let user = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });
    const now = utcNow();
    if (!user) {
      const userId = newId();
      await this.prisma.user.create({
        data: {
          id: userId,
          phone,
          fullName,
          userType: UserType.Driver,
          ...userDefaults(now),
        },
      });
      await this.prisma.wallet.create({
        data: { id: newId(), userId, ...walletDefaults(now) },
      });
      user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    } else if (user.userType !== UserType.Driver && user.userType !== UserType.Admin) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { userType: UserType.Driver, updatedAt: now },
      });
    }
    const driver = await this.prisma.driver.findFirst({
      where: { userId: user.id, isDeleted: false },
    });
    if (!driver) {
      await this.prisma.driver.create({
        data: {
          id: newId(),
          userId: user.id,
          verificationStatus: DriverVerificationStatus.Approved,
          ...driverDefaults(now),
          isActive: true,
        },
      });
    }
  }
}

function validateLandingPhone(phone: string): void {
  const digits = digitsOnly(phone);
  if (digits.length < 11) {
    throw new AppException('يرجى إدخال رقم موبايل صحيح (11 رقم على الأقل)');
  }
}

function digitsOnly(phone: string): string {
  return [...phone].filter((ch) => ch >= '0' && ch <= '9').join('');
}

export function splitRouteName(name: string): { from: string; to: string } {
  const parts = name.split(/[-–—]|إلى|to/i).map((p) => p.trim());
  if (parts.length >= 2) {
    return { from: parts[0], to: parts[parts.length - 1] };
  }
  return { from: name, to: name };
}
