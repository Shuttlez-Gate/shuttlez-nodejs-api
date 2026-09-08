import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiResponse } from '../../../common/api-response';
import { AdminOnlyGuard } from '../../../common/guards/admin-only.guard';
import { AuthService } from '../../auth/auth.service';
import { AdminLoginRequest, AdminSendOtpRequest } from '../../auth/auth.dto';
import { clientIp } from '../../auth/auth.controller';

@ApiTags('admin-auth')
@Controller('api/v1/admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('send-otp')
  async sendOtp(@Body() request: AdminSendOtpRequest) {
    const result = await this.auth.sendAdminOtp(request.phone);
    return ApiResponse.ok(result, result.message);
  }

  @Post('login')
  async login(@Body() request: AdminLoginRequest, @Req() req: Request) {
    const result = await this.auth.adminLogin(request, clientIp(req));
    return ApiResponse.ok(result, 'تم تسجيل الدخول');
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AdminOnlyGuard)
  async me() {
    const result = await this.auth.adminMe();
    return ApiResponse.ok(result);
  }
}
