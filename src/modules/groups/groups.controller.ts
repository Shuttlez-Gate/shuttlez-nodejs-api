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
  async join(
    @Param('groupId') groupId: string,
    @Body()
    body?: {
      pickupLatitude?: number;
      pickupLongitude?: number;
      pickupAddress?: string;
    },
  ) {
    return ApiResponse.ok(
      await this.groups.join(groupId, body),
      'تم الانضمام للمجموعة',
    );
  }

  @Post(':groupId/pickup')
  async pickup(
    @Param('groupId') groupId: string,
    @Body()
    body?: {
      pickupLatitude?: number;
      pickupLongitude?: number;
      pickupAddress?: string;
    },
  ) {
    return ApiResponse.ok(
      await this.groups.setPickup(groupId, body),
      'تم حفظ نقطة الانطلاق',
    );
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

  @Get('invite/:code')
  async invite(@Param('code') code: string) {
    return ApiResponse.ok(await this.groups.invite(code));
  }

  @Get(':groupId/messages/unread')
  async unread(@Param('groupId') groupId: string) {
    return ApiResponse.ok(await this.groups.unreadMemberMessages(groupId));
  }

  @Get(':groupId/messages/typing')
  async typingPeers(@Param('groupId') groupId: string) {
    return ApiResponse.ok(await this.groups.memberTypingPeers(groupId));
  }

  @Post(':groupId/messages/typing')
  async typing(
    @Param('groupId') groupId: string,
    @Body() body?: { peerUserId?: string; typing?: boolean },
  ) {
    return ApiResponse.ok(
      await this.groups.notifyMemberTyping(
        groupId,
        body?.peerUserId ?? '',
        body?.typing === true,
      ),
    );
  }

  @Post(':groupId/messages/read')
  async markRead(
    @Param('groupId') groupId: string,
    @Body() body?: { peerUserId?: string },
  ) {
    return ApiResponse.ok(
      await this.groups.markMemberMessagesRead(groupId, body?.peerUserId ?? ''),
    );
  }

  @Get(':groupId/messages')
  async messages(
    @Param('groupId') groupId: string,
    @Query('peerUserId') peerUserId?: string,
  ) {
    return ApiResponse.ok(
      await this.groups.listMemberMessages(groupId, peerUserId ?? ''),
    );
  }

  @Post(':groupId/messages')
  async sendMessage(
    @Param('groupId') groupId: string,
    @Body() body?: { peerUserId?: string; body?: string },
  ) {
    return ApiResponse.ok(
      await this.groups.sendMemberMessage(groupId, body),
      'تم إرسال الرسالة',
    );
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
