import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiResponse } from '../../common/api-response';
import { AuthService } from './auth.service';
import {
  RefreshTokenRequest,
  RegisterRequest,
  SendOtpRequest,
  SocialCompleteRequest,
  SocialLoginRequest,
  SocialSendOtpRequest,
  UpdateProfileRequest,
  VerifyOtpRequest,
} from './auth.dto';

@ApiTags('auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('send-otp')
  @ApiOperation({ summary: 'Send OTP' })
  async sendOtp(@Body() request: SendOtpRequest) {
    const result = await this.auth.sendOtp(request);
    return ApiResponse.ok(result, result.message);
  }

  @Post('verify-otp')
  async verifyOtp(@Body() request: VerifyOtpRequest, @Req() req: Request) {
    const result = await this.auth.verifyOtp(request, clientIp(req));
    return ApiResponse.ok(result, 'تم تسجيل الدخول بنجاح');
  }

  @Post('register')
  async register(@Body() request: RegisterRequest, @Req() req: Request) {
    const result = await this.auth.register(request, clientIp(req));
    return ApiResponse.ok(result, 'تم إنشاء الحساب بنجاح');
  }

  @Post('social-login')
  async socialLogin(@Body() request: SocialLoginRequest, @Req() req: Request) {
    const result = await this.auth.socialLogin(request, clientIp(req));
    const message = result.requiresPhoneVerification
      ? 'يلزم توثيق رقم الهاتف لإكمال الربط'
      : 'تم تسجيل الدخول بنجاح';
    const code = result.requiresPhoneVerification
      ? 'PHONE_VERIFICATION_REQUIRED'
      : 'AUTHENTICATED';
    return ApiResponse.ok(result, message, code);
  }

  @Post('social-send-otp')
  async socialSendOtp(@Body() request: SocialSendOtpRequest) {
    const result = await this.auth.socialSendOtp(request);
    return ApiResponse.ok(result, result.message, 'OTP_SENT');
  }

  @Post('social-complete')
  async socialComplete(
    @Body() request: SocialCompleteRequest,
    @Req() req: Request,
  ) {
    const result = await this.auth.socialComplete(request, clientIp(req));
    return ApiResponse.ok(result, 'تم إكمال الربط بنجاح', 'ACCOUNT_LINKED');
  }

  @Post('refresh-token')
  async refreshToken(@Body() request: RefreshTokenRequest, @Req() req: Request) {
    const result = await this.auth.refreshToken(request.refreshToken, clientIp(req));
    return ApiResponse.ok(result);
  }

  @Post('logout')
  async logout(@Body() request: RefreshTokenRequest) {
    await this.auth.logout(request.refreshToken);
    return ApiResponse.ok(undefined, 'تم تسجيل الخروج');
  }
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  async getMe() {
    const profile = await this.auth.getMe();
    return ApiResponse.ok(profile);
  }

  @Patch('me')
  async updateMe(@Body() request: UpdateProfileRequest) {
    const profile = await this.auth.updateMe(request);
    return ApiResponse.ok(profile, 'تم تحديث الملف الشخصي');
  }
}

export function clientIp(req: Request): string | undefined {
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}
