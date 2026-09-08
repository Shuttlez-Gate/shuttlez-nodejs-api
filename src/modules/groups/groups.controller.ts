import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { GroupsService } from './groups.service';

@ApiTags('groups')
@ApiBearerAuth()
@Controller('api/v1/groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get('quote')
  async quote(
    @Query('fromZoneKey') fromZoneKey?: string,
    @Query('toZoneKey') toZoneKey?: string,
    @Query('pickupLatitude') pickupLatitude?: string,
    @Query('pickupLongitude') pickupLongitude?: string,
    @Query('destinationLatitude') destinationLatitude?: string,
    @Query('destinationLongitude') destinationLongitude?: string,
  ) {
    return ApiResponse.ok(
      await this.groups.quote({
        fromZoneKey,
        toZoneKey,
        pickupLatitude: num(pickupLatitude),
        pickupLongitude: num(pickupLongitude),
        destinationLatitude: num(destinationLatitude),
        destinationLongitude: num(destinationLongitude),
      }),
    );
  }

  @Get('fare-options')
  async fareOptions() {
    return ApiResponse.ok(await this.groups.fareOptions());
  }

  @Post()
  async create(
    @Body()
    body: {
      pickupLatitude: number;
      pickupLongitude: number;
      destinationLatitude: number;
      destinationLongitude: number;
      capacity: number;
      pickupAddress?: string;
      destinationAddress?: string;
      fromZoneKey?: string;
      toZoneKey?: string;
    },
  ) {
    return ApiResponse.ok(
      await this.groups.create(body),
      'تم إنشاء المجموعة كمسودة',
    );
  }

  @Post(':groupId/join')
  async join(@Param('groupId') groupId: string) {
    return ApiResponse.ok(await this.groups.join(groupId), 'تم الانضمام للمجموعة');
  }

  @Post(':groupId/leave')
  async leave(@Param('groupId') groupId: string) {
    return ApiResponse.ok(await this.groups.leave(groupId), 'تم مغادرة المجموعة');
  }

  @Post(':groupId/confirm')
  async confirm(
    @Param('groupId') groupId: string,
    @Body() body?: { paymentMethod?: string },
  ) {
    return ApiResponse.ok(
      await this.groups.confirm(groupId, body?.paymentMethod),
      'تم تأكيد المجموعة — الدفع نقدًا للكابتن',
    );
  }

  @Get('me')
  async me() {
    return ApiResponse.ok(await this.groups.mine());
  }

  @Get(':groupId')
  async byId(@Param('groupId') groupId: string) {
    return ApiResponse.ok(await this.groups.byId(groupId));
  }

  @Post(':groupId/cancel')
  async cancel(@Param('groupId') groupId: string) {
    return ApiResponse.ok(
      await this.groups.cancel(groupId),
      'تم إلغاء المجموعة',
    );
  }
}

function num(value?: string): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
