import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { addHours, addMinutes } from '../../common/utils/date.util';
import { userTypeName } from '../../common/enums';

const NAME_ID =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier';
const ROLE_URI =
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';
const MOBILE =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobilephone';

export interface JwtUserPayload {
  id: string;
  phone: string;
  userType: number;
}

@Injectable()
export class JwtTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  generateAccessToken(user: JwtUserPayload): string {
    const minutes = Number(this.config.get('JWT_ACCESS_TOKEN_MINUTES') ?? 60);
    const payload: Record<string, string> = {
      sub: user.id,
      phone_number: user.phone,
      [MOBILE]: user.phone,
      [NAME_ID]: user.id,
      [ROLE_URI]: userTypeName(user.userType),
    };

    return this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      issuer: this.config.get<string>('JWT_ISSUER', 'Shuttlez'),
      audience: this.config.get<string>('JWT_AUDIENCE', 'ShuttlezApp'),
      expiresIn: `${minutes}m`,
      algorithm: 'HS256',
    });
  }

  generateRefreshToken(): string {
    return randomBytes(64).toString('base64');
  }

  accessTokenExpiresAt(now = new Date()): Date {
    return addHours(now, 1);
  }

  refreshTokenExpiresAt(now = new Date()): Date {
    const days = Number(this.config.get('JWT_REFRESH_TOKEN_DAYS') ?? 30);
    return new Date(now.getTime() + days * 86_400_000);
  }

  jwtExpiresAt(now = new Date()): Date {
    const minutes = Number(this.config.get('JWT_ACCESS_TOKEN_MINUTES') ?? 60);
    return addMinutes(now, minutes);
  }

  getUserIdFromExpiredToken(token: string): string | undefined {
    try {
      const payload = this.jwt.verify<Record<string, unknown>>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: this.config.get<string>('JWT_ISSUER', 'Shuttlez'),
        audience: this.config.get<string>('JWT_AUDIENCE', 'ShuttlezApp'),
        ignoreExpiration: true,
      });
      const id =
        (payload[NAME_ID] as string | undefined) ??
        (payload.sub as string | undefined);
      return id;
    } catch {
      return undefined;
    }
  }
}
