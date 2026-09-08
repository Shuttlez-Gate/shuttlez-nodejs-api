import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { PrismaService } from '../../database/prisma/prisma.service';
import { pageRequestFrom, PagedResult } from '../../common/paged-result';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { DriverVerificationStatus, UserType } from '../../common/enums';
import { normalizePhone } from '../../common/utils/phone-normalizer';
import { newId, utcNow } from '../../common/utils/date.util';
import {
  baseFields,
  driverDefaults,
  userDefaults,
  walletDefaults,
} from '../../common/utils/entity-defaults';
import { money } from '../../common/utils/money';
import {
  documentTypeLabel,
  parseDocumentType,
  parseUserType,
  parseVehicleType,
  parseVerification,
  userTypeLabel,
  vehicleTypeLabel,
  verificationLabel,
} from '../../common/utils/enums-map';
import { parseGender } from '../auth/auth.mapper';

@ApiTags('admin-users')
@AdminOnly()
@Controller('api/v1/admin/users')
export class AdminUsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('userType') userType?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const type = userType ? parseUserType(userType) : undefined;
    const where: Prisma.UserWhereInput = {
      isDeleted: false,
      ...(type != null ? { userType: type } : {}),
      ...(isActive != null && isActive !== ''
        ? { isActive: isActive === 'true' }
        : {}),
      ...(search
        ? {
            OR: [
              { phone: { contains: search } },
              { fullName: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { wallet: true, _count: { select: { bookings: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(items.map(mapAdminUser), paging.page, paging.pageSize, totalCount),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, isDeleted: false },
      include: { wallet: true, _count: { select: { bookings: true } } },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }
    return ApiResponse.ok(mapAdminUser(user));
  }

  @Post()
  async create(
    @Body()
    body: {
      phone: string;
      fullName?: string;
      email?: string;
      gender?: string;
      userType?: string;
    },
  ) {
    const phone = normalizePhone(body.phone);
    const exists = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });
    if (exists) {
      throw new AppException('رقم الهاتف مسجل بالفعل');
    }
    const userType = parseUserType(body.userType);
    const user = await this.prisma.user.create({
      data: {
        id: newId(),
        phone,
        fullName: body.fullName,
        email: body.email,
        gender: parseGender(body.gender),
        userType,
        ...userDefaults(),
        wallet: { create: { id: newId(), ...walletDefaults() } },
        ...(userType === UserType.Driver
          ? {
              driver: {
                create: {
                  id: newId(),
                  isActive: true,
                  verificationStatus: DriverVerificationStatus.Pending,
                  ...driverDefaults(),
                },
              },
            }
          : {}),
      },
      include: { wallet: true, _count: { select: { bookings: true } } },
    });
    return ApiResponse.ok(mapAdminUser(user), 'تم إنشاء المستخدم');
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      fullName?: string;
      email?: string;
      gender?: string;
      avatarUrl?: string;
      userType?: string;
      isActive?: boolean;
    },
  ) {
    const user = await this.requireUser(id);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        fullName: body.fullName ?? user.fullName,
        email: body.email ?? user.email,
        gender: body.gender != null ? parseGender(body.gender) : user.gender,
        avatarUrl: body.avatarUrl ?? user.avatarUrl,
        userType: body.userType != null ? parseUserType(body.userType) : user.userType,
        isActive: body.isActive ?? user.isActive,
        updatedAt: utcNow(),
      },
      include: { wallet: true, _count: { select: { bookings: true } } },
    });
    return ApiResponse.ok(mapAdminUser(updated), 'تم تحديث المستخدم');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const user = await this.requireUser(id);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { isDeleted: true, isActive: false, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم حذف المستخدم');
  }

  @Post(':id/wallet')
  async wallet(
    @Param('id') id: string,
    @Body() body: { amount: number; description?: string },
  ) {
    const user = await this.requireUser(id);
    let wallet = await this.prisma.wallet.findFirst({
      where: { userId: user.id, isDeleted: false },
    });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: { id: newId(), userId: user.id, ...walletDefaults() },
      });
    }
    const next = money(wallet.balance) + Number(body.amount);
    await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: new Prisma.Decimal(next), updatedAt: utcNow() },
      }),
      this.prisma.walletTransaction.create({
        data: {
          id: newId(),
          walletId: wallet.id,
          amount: new Prisma.Decimal(body.amount),
          type: body.amount >= 0 ? 'credit' : 'debit',
          description: body.description,
          ...baseFields(),
        },
      }),
    ]);
    return ApiResponse.ok(next, 'تم تعديل الرصيد');
  }

  private async requireUser(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, isDeleted: false },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }
    return user;
  }
}

@ApiTags('admin-vehicles')
@AdminOnly()
@Controller('api/v1/admin/vehicles')
export class AdminVehiclesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.VehicleWhereInput = {
      isDeleted: false,
      ...(type ? { type: parseVehicleType(type) } : {}),
      ...(isActive != null && isActive !== ''
        ? { isActive: isActive === 'true' }
        : {}),
      ...(search
        ? {
            OR: [
              { plateNumber: { contains: search } },
              { model: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.vehicle.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { drivers: true } } },
      }),
      this.prisma.vehicle.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((v) => ({
          id: v.id,
          plateNumber: v.plateNumber,
          model: v.model,
          type: vehicleTypeLabel(v.type),
          capacity: v.capacity,
          isActive: v.isActive,
          driverCount: v._count.drivers,
          createdAt: v.createdAt,
        })),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Post()
  async create(
    @Body()
    body: {
      plateNumber: string;
      model: string;
      type: string;
      capacity: number;
      isActive?: boolean;
    },
  ) {
    const vehicle = await this.prisma.vehicle.create({
      data: {
        id: newId(),
        plateNumber: body.plateNumber,
        model: body.model,
        type: parseVehicleType(body.type),
        capacity: body.capacity,
        isActive: body.isActive ?? true,
        ...baseFields(),
      },
      include: { _count: { select: { drivers: true } } },
    });
    return ApiResponse.ok(mapVehicle(vehicle), 'تمت إضافة المركبة');
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      plateNumber: string;
      model: string;
      type: string;
      capacity: number;
      isActive?: boolean;
    },
  ) {
    await this.requireVehicle(id);
    const vehicle = await this.prisma.vehicle.update({
      where: { id },
      data: {
        plateNumber: body.plateNumber,
        model: body.model,
        type: parseVehicleType(body.type),
        capacity: body.capacity,
        isActive: body.isActive ?? true,
        updatedAt: utcNow(),
      },
      include: { _count: { select: { drivers: true } } },
    });
    return ApiResponse.ok(mapVehicle(vehicle), 'تم تحديث المركبة');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.requireVehicle(id);
    await this.prisma.vehicle.update({
      where: { id },
      data: { isDeleted: true, isActive: false, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم حذف المركبة');
  }

  private async requireVehicle(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, isDeleted: false },
    });
    if (!vehicle) {
      throw new NotFoundException('المركبة غير موجودة');
    }
    return vehicle;
  }
}

@ApiTags('admin-drivers')
@AdminOnly()
@Controller('api/v1/admin/drivers')
export class AdminDriversController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('isOnline') isOnline?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.DriverWhereInput = {
      isDeleted: false,
      ...(isOnline != null && isOnline !== ''
        ? { isOnline: isOnline === 'true' }
        : {}),
      ...(isActive != null && isActive !== ''
        ? { isActive: isActive === 'true' }
        : {}),
      ...(search
        ? {
            OR: [
              { user: { phone: { contains: search } } },
              { user: { fullName: { contains: search } } },
              { plateNumber: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.driver.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: true,
          vehicle: true,
          _count: { select: { documents: true, trips: true } },
        },
      }),
      this.prisma.driver.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(items.map(mapDriverList), paging.page, paging.pageSize, totalCount),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id, isDeleted: false },
      include: {
        user: true,
        vehicle: true,
        documents: { where: { isDeleted: false } },
        _count: { select: { trips: true } },
      },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود', ErrorCodes.DriverNotFound);
    }
    return ApiResponse.ok({
      id: driver.id,
      userId: driver.userId,
      phone: driver.user.phone,
      fullName: driver.user.fullName,
      email: driver.user.email,
      gender: driver.user.gender,
      avatarUrl: driver.user.avatarUrl,
      vehicleId: driver.vehicleId,
      vehiclePlate: driver.vehicle?.plateNumber,
      vehicleModel: driver.vehicle?.model,
      ratingAverage: money(driver.ratingAverage),
      ratingCount: driver.ratingCount,
      isOnline: driver.isOnline,
      isActive: driver.isActive,
      verificationStatus: verificationLabel(driver.verificationStatus),
      nationalId: driver.nationalId,
      birthDate: driver.birthDate,
      licenseNumber: driver.licenseNumber,
      licenseType: driver.licenseType,
      licenseExpiry: driver.licenseExpiry,
      vehicleKind: driver.vehicleKind,
      vehicleModelName: driver.vehicleModelName,
      manufactureYear: driver.manufactureYear,
      plateNumber: driver.plateNumber,
      vehicleColor: driver.vehicleColor,
      seats: driver.seats,
      adminNotes: driver.adminNotes,
      verifiedAt: driver.verifiedAt,
      tripCount: driver._count.trips,
      createdAt: driver.createdAt,
      documents: driver.documents.map(mapDoc),
    });
  }

  @Post()
  async create(
    @Body()
    body: {
      phone: string;
      fullName?: string;
      vehicleId?: string;
      email?: string;
      gender?: string;
      verificationStatus?: string;
      isActive?: boolean;
      isOnline?: boolean;
      nationalId?: string;
      plateNumber?: string;
      adminNotes?: string;
    },
  ) {
    const phone = normalizePhone(body.phone);
    let user = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          id: newId(),
          phone,
          fullName: body.fullName,
          email: body.email,
          gender: parseGender(body.gender),
          userType: UserType.Driver,
          ...userDefaults(),
          wallet: { create: { id: newId(), ...walletDefaults() } },
        },
      });
    } else if (user.userType !== UserType.Driver) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { userType: UserType.Driver, updatedAt: utcNow() },
      });
    }
    const existing = await this.prisma.driver.findFirst({
      where: { userId: user.id, isDeleted: false },
    });
    if (existing) {
      throw new AppException('الكابتن مسجل بالفعل');
    }
    const driver = await this.prisma.driver.create({
      data: {
        id: newId(),
        userId: user.id,
        vehicleId: body.vehicleId,
        isActive: body.isActive ?? true,
        isOnline: body.isOnline ?? false,
        verificationStatus: parseVerification(body.verificationStatus),
        nationalId: body.nationalId,
        plateNumber: body.plateNumber,
        adminNotes: body.adminNotes,
        ratingAverage: 0,
        ratingCount: 0,
        ...baseFields(),
      },
      include: {
        user: true,
        vehicle: true,
        _count: { select: { documents: true, trips: true } },
      },
    });
    return ApiResponse.ok(mapDriverList(driver), 'تمت إضافة الكابتن');
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      vehicleId?: string | null;
      isOnline?: boolean;
      isActive?: boolean;
      fullName?: string;
      email?: string;
      verificationStatus?: string;
      nationalId?: string;
      plateNumber?: string;
      adminNotes?: string;
      seats?: number;
    },
  ) {
    const driver = await this.prisma.driver.findFirst({
      where: { id, isDeleted: false },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود', ErrorCodes.DriverNotFound);
    }
    await this.prisma.user.update({
      where: { id: driver.userId },
      data: {
        fullName: body.fullName,
        email: body.email,
        updatedAt: utcNow(),
      },
    });
    const updated = await this.prisma.driver.update({
      where: { id },
      data: {
        vehicleId: body.vehicleId === undefined ? driver.vehicleId : body.vehicleId,
        isOnline: body.isOnline ?? driver.isOnline,
        isActive: body.isActive ?? driver.isActive,
        verificationStatus: body.verificationStatus
          ? parseVerification(body.verificationStatus)
          : driver.verificationStatus,
        nationalId: body.nationalId ?? driver.nationalId,
        plateNumber: body.plateNumber ?? driver.plateNumber,
        adminNotes: body.adminNotes ?? driver.adminNotes,
        seats: body.seats ?? driver.seats,
        updatedAt: utcNow(),
      },
      include: {
        user: true,
        vehicle: true,
        _count: { select: { documents: true, trips: true } },
      },
    });
    return ApiResponse.ok(mapDriverList(updated), 'تم تحديث الكابتن');
  }

  @Post(':id/documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 16 * 1024 * 1024 },
    }),
  )
  async upload(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('documentType') documentType?: string,
    @Body('notes') notes?: string,
  ) {
    const driver = await this.prisma.driver.findFirst({
      where: { id, isDeleted: false },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود');
    }
    if (!file?.buffer?.length) {
      throw new AppException('الملف مطلوب');
    }
    const dir = join(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
    mkdirSync(dir, { recursive: true });
    const stored = `${id}-${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`;
    writeFileSync(join(dir, stored), file.buffer);
    const doc = await this.prisma.driverDocument.create({
      data: {
        id: newId(),
        driverId: id,
        documentType: parseDocumentType(documentType),
        fileName: file.originalname,
        contentType: file.mimetype || 'application/octet-stream',
        sizeBytes: BigInt(file.size),
        storagePath: stored,
        notes: notes ?? null,
        uploadedBy: 'admin',
        ...baseFields(),
      },
    });
    return ApiResponse.ok(mapDoc(doc), 'تم رفع المرفق');
  }

  @Delete(':id/documents/:documentId')
  async deleteDoc(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    const doc = await this.prisma.driverDocument.findFirst({
      where: { id: documentId, driverId: id, isDeleted: false },
    });
    if (!doc) {
      throw new NotFoundException('المرفق غير موجود');
    }
    await this.prisma.driverDocument.update({
      where: { id: documentId },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم حذف المرفق');
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id, isDeleted: false },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود');
    }
    await this.prisma.driver.update({
      where: { id },
      data: { isDeleted: true, isActive: false, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true, 'تم حذف الكابتن');
  }
}

function mapAdminUser(user: {
  id: string;
  phone: string;
  fullName: string | null;
  email: string | null;
  gender: number | null;
  avatarUrl: string | null;
  userType: number;
  ratingAverage: Prisma.Decimal | number;
  ratingCount: number;
  isActive: boolean;
  createdAt: Date;
  wallet: { balance: Prisma.Decimal | number } | null;
  _count: { bookings: number };
}) {
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    email: user.email,
    gender: user.gender,
    avatarUrl: user.avatarUrl,
    userType: userTypeLabel(user.userType),
    ratingAverage: money(user.ratingAverage),
    ratingCount: user.ratingCount,
    isActive: user.isActive,
    walletBalance: user.wallet ? money(user.wallet.balance) : 0,
    bookingCount: user._count.bookings,
    createdAt: user.createdAt,
  };
}

function mapVehicle(v: {
  id: string;
  plateNumber: string;
  model: string;
  type: number;
  capacity: number;
  isActive: boolean;
  createdAt: Date;
  _count: { drivers: number };
}) {
  return {
    id: v.id,
    plateNumber: v.plateNumber,
    model: v.model,
    type: vehicleTypeLabel(v.type),
    capacity: v.capacity,
    isActive: v.isActive,
    driverCount: v._count.drivers,
    createdAt: v.createdAt,
  };
}

function mapDriverList(d: {
  id: string;
  userId: string;
  vehicleId: string | null;
  ratingAverage: Prisma.Decimal | number;
  ratingCount: number;
  isOnline: boolean;
  isActive: boolean;
  verificationStatus: number;
  createdAt: Date;
  user: { phone: string; fullName: string | null };
  vehicle: { plateNumber: string; model: string } | null;
  _count: { documents: number; trips: number };
}) {
  return {
    id: d.id,
    userId: d.userId,
    phone: d.user.phone,
    fullName: d.user.fullName,
    vehicleId: d.vehicleId,
    vehiclePlate: d.vehicle?.plateNumber,
    vehicleModel: d.vehicle?.model,
    ratingAverage: money(d.ratingAverage),
    ratingCount: d.ratingCount,
    isOnline: d.isOnline,
    isActive: d.isActive,
    verificationStatus: verificationLabel(d.verificationStatus),
    documentCount: d._count.documents,
    tripCount: d._count.trips,
    createdAt: d.createdAt,
  };
}

function mapDoc(d: {
  id: string;
  documentType: number;
  fileName: string;
  contentType: string;
  sizeBytes: bigint;
  storagePath: string;
  uploadedBy: string;
  notes: string | null;
  createdAt: Date;
}) {
  return {
    id: d.id,
    documentType: documentTypeLabel(d.documentType),
    fileName: d.fileName,
    contentType: d.contentType,
    sizeBytes: Number(d.sizeBytes),
    url: `/uploads/${d.storagePath}`,
    uploadedBy: d.uploadedBy,
    notes: d.notes,
    createdAt: d.createdAt,
  };
}
