import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../../database/prisma/prisma.service';
import { OtpPurpose } from '../../common/enums';
import { normalizePhone } from '../../common/utils/phone-normalizer';
import { addMinutes, newId } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';

export interface SendOtpResult {
  message: string;
  debugCode?: string;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendOtp(phone: string, purpose: OtpPurpose): Promise<SendOtpResult> {
    const normalizedPhone = normalizePhone(phone);
    const length = Number(this.config.get('OTP_CODE_LENGTH') ?? 4);
    const expiryMinutes = Number(this.config.get('OTP_EXPIRY_MINUTES') ?? 5);
    const code = generateCode(length);

    await this.prisma.otpRequest.create({
      data: {
        id: newId(),
        phone: normalizedPhone,
        codeHash: hashCode(code),
        purpose,
        expiresAt: addMinutes(new Date(), expiryMinutes),
        attempts: 0,
        isUsed: false,
        ...baseFields(),
      },
    });

    const isDev = this.config.get('NODE_ENV') !== 'production';
    const logInDev = this.config.get('OTP_LOG_CODE_IN_DEVELOPMENT') !== 'false';
    if (isDev && logInDev) {
      this.logger.warn(`OTP for ${normalizedPhone}: ${code}`);
    } else {
      this.logger.log(
        `OTP generated for ${normalizedPhone} (SMS/FCM not configured)`,
      );
    }

    return { message: 'تم إرسال رمز التحقق', debugCode: code };
  }

  async verifyOtp(
    phone: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<boolean> {
    const normalizedPhone = normalizePhone(phone);
    const maxAttempts = Number(this.config.get('OTP_MAX_ATTEMPTS') ?? 5);

    const otp = await this.prisma.otpRequest.findFirst({
      where: {
        phone: normalizedPhone,
        purpose,
        isUsed: false,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.expiresAt < new Date()) {
      return false;
    }

    const attempts = otp.attempts + 1;
    if (attempts > maxAttempts) {
      await this.prisma.otpRequest.update({
        where: { id: otp.id },
        data: { attempts, isUsed: true },
      });
      return false;
    }

    const valid = otp.codeHash === hashCode(code);
    await this.prisma.otpRequest.update({
      where: { id: otp.id },
      data: {
        attempts,
        isUsed: valid ? true : otp.isUsed,
      },
    });
    return valid;
  }
}

function generateCode(length: number): string {
  const max = 10 ** length;
  const value = randomInt(0, max);
  return value.toString().padStart(length, '0');
}

/** Match .NET Convert.ToHexString (uppercase hex). */
function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').toUpperCase();
}
