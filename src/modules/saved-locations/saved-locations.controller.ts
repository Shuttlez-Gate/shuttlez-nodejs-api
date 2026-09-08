import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import { NotFoundException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../database/prisma/prisma.service';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';

@ApiTags('saved-locations')
@ApiBearerAuth()
@Controller('api/v1/users/me/saved-locations')
export class SavedLocationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get()
  async list() {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.savedLocation.findMany({
      where: { userId, isDeleted: false },
      orderBy: [{ isFavorite: 'desc' }, { createdAt: 'desc' }],
    });
    return ApiResponse.ok(items.map(mapLocation));
  }

  @Post()
  async create(
    @Body()
    body: {
      label: string;
      address: string;
      latitude: number;
      longitude: number;
      isFavorite?: boolean;
    },
  ) {
    const userId = this.currentUser.requireUserId();
    const entity = await this.prisma.savedLocation.create({
      data: {
        id: newId(),
        userId,
        label: body.label.trim(),
        address: body.address.trim(),
        latitude: body.latitude,
        longitude: body.longitude,
        isFavorite: body.isFavorite ?? false,
        ...baseFields(),
      },
    });
    return ApiResponse.ok(mapLocation(entity));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      label?: string;
      address?: string;
      latitude?: number;
      longitude?: number;
      isFavorite?: boolean;
    },
  ) {
    const entity = await this.findOwned(id);
    const updated = await this.prisma.savedLocation.update({
      where: { id: entity.id },
      data: {
        label: body.label?.trim() || entity.label,
        address: body.address?.trim() || entity.address,
        latitude: body.latitude ?? entity.latitude,
        longitude: body.longitude ?? entity.longitude,
        isFavorite: body.isFavorite ?? entity.isFavorite,
        updatedAt: utcNow(),
      },
    });
    return ApiResponse.ok(mapLocation(updated));
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const entity = await this.findOwned(id);
    await this.prisma.savedLocation.update({
      where: { id: entity.id },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    return ApiResponse.ok(undefined);
  }

  @Patch(':id/favorite')
  async favorite(@Param('id') id: string) {
    const entity = await this.findOwned(id);
    const updated = await this.prisma.savedLocation.update({
      where: { id: entity.id },
      data: { isFavorite: !entity.isFavorite, updatedAt: utcNow() },
    });
    return ApiResponse.ok(mapLocation(updated));
  }

  private async findOwned(id: string) {
    const userId = this.currentUser.requireUserId();
    const entity = await this.prisma.savedLocation.findFirst({
      where: { id, userId, isDeleted: false },
    });
    if (!entity) {
      throw new NotFoundException('الموقع غير موجود');
    }
    return entity;
  }
}

function mapLocation(entity: {
  id: string;
  label: string;
  address: string;
  latitude: number;
  longitude: number;
  isFavorite: boolean;
  createdAt: Date;
}) {
  return {
    id: entity.id,
    label: entity.label,
    address: entity.address,
    latitude: entity.latitude,
    longitude: entity.longitude,
    isFavorite: entity.isFavorite,
    createdAt: entity.createdAt,
  };
}
