import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController, UsersController } from './auth.controller';
import { AdminAuthController } from '../admin/auth/admin-auth.controller';
import { AuthService } from './auth.service';
import { JwtTokenService } from './jwt-token.service';
import { OtpService } from './otp.service';
import { FirebaseTokenVerifier } from '../../integrations/firebase/firebase-token.verifier';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          issuer: config.get<string>('JWT_ISSUER', 'Shuttlez'),
          audience: config.get<string>('JWT_AUDIENCE', 'ShuttlezApp'),
        },
      }),
    }),
  ],
  controllers: [AuthController, UsersController, AdminAuthController],
  providers: [
    AuthService,
    OtpService,
    JwtTokenService,
    FirebaseTokenVerifier,
  ],
  exports: [AuthService, JwtTokenService, OtpService],
})
export class AuthModule {}
