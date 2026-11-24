import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiResponse } from '../../common/api-response';
import { AuthService } from './auth.service';
import { monotonicNow, recordPerformanceDiagnostic } from '../../common/performance-diagnostics';
import { RegistrationTimingInterceptor } from './registration-timing.interceptor';
import {
  ChangePasswordRequest,
  ChangePhoneRequest,
  PasswordLoginRequest,
  RefreshTokenRequest,
  ResetPasswordRequest,
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

  @Post('reset-password')
  @ApiOperation({ summary: 'Set a new password after phone OTP' })
  async resetPassword(@Body() request: ResetPasswordRequest, @Req() req: Request) {
    const result = await this.auth.resetPassword(request, clientIp(req));
    return ApiResponse.ok(result, 'تم تعيين كلمة المرور');
  }

  @Post('login')
  @ApiOperation({ summary: 'Rider login with phone and password' })
  async login(@Body() request: PasswordLoginRequest, @Req() req: Request) {
    const result = await this.auth.loginWithPassword(request, clientIp(req));
    return ApiResponse.ok(result, 'تم تسجيل الدخول بنجاح');
  }

  @Post('register')
  @UseInterceptors(RegistrationTimingInterceptor)
  async register(@Body() request: RegisterRequest, @Req() req: Request) {
    const result = await this.auth.register(request, clientIp(req));
    const responseBuildStartedAt = monotonicNow();
    const response = ApiResponse.ok(result, 'تم إنشاء الحساب بنجاح');
    recordPerformanceDiagnostic('registration.response_build', {
      durationMs: monotonicNow() - responseBuildStartedAt,
    });
    return response;
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

  @Post('logout-all')
  async logoutAll() {
    await this.auth.revokeAllSessions();
    return ApiResponse.ok(undefined, 'تم تسجيل الخروج من كل الأجهزة');
  }

  @Get('sessions')
  async sessions() {
    return ApiResponse.ok(await this.auth.listSessions());
  }

  @Post('sessions/:id/revoke')
  async revokeSession(@Param('id') id: string) {
    await this.auth.revokeSession(id);
    return ApiResponse.ok(undefined, 'تم إنهاء الجلسة');
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

  @Patch('me/password')
  @ApiOperation({ summary: 'Set or change the signed-in rider password' })
  async changePassword(@Body() request: ChangePasswordRequest, @Req() req: Request) {
    const result = await this.auth.changePassword(request, clientIp(req));
    return ApiResponse.ok(result, 'تم تغيير كلمة المرور');
  }

  @Patch('me/phone')
  async changePhone(@Body() request: ChangePhoneRequest, @Req() req: Request) {
    const result = await this.auth.changePhone(request, clientIp(req));
    return ApiResponse.ok(result, 'تم تحديث رقم الهاتف');
  }

  @Patch('me')
  async updateMe(@Body() request: UpdateProfileRequest) {
    const profile = await this.auth.updateMe(request);
    return ApiResponse.ok(profile, 'تم تحديث الملف الشخصي');
  }

  @Delete('me')
  @ApiOperation({ summary: 'Soft-delete the signed-in rider account' })
  async deleteMe() {
    await this.auth.deleteMe();
    return ApiResponse.ok(undefined, 'تم حذف الحساب');
  }
}

export function clientIp(req: Request): string | undefined {
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}
