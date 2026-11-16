import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../database/prisma/prisma.service';
import { OtpPurpose } from '../../common/enums';
import { newId } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { normalizePhone } from '../../common/utils/phone-normalizer';

export interface SendOtpResult {
  message: string;
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendOtp(phone: string, purpose: OtpPurpose): Promise<SendOtpResult> {
    normalizePhone(phone);
    void purpose;
    return {
      message: 'يتم التحقق من رقم الهاتف عبر Firebase. رمز الدخول القديم لم يعد يُستخدم',
    };
  }

  /** Chrome-only test code. The database stores the hash, never the digits. */
  async issueWebTestCode(phone: string, purpose: OtpPurpose): Promise<string> {
    const normalizedPhone = normalizePhone(phone);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    await this.prisma.otpRequest.updateMany({
      where: { phone: normalizedPhone, purpose, isUsed: false },
      data: { isUsed: true, updatedAt: now },
    });
    await this.prisma.otpRequest.create({
      data: {
        id: newId(),
        phone: normalizedPhone,
        codeHash: hashCode(code),
        purpose,
        expiresAt,
        attempts: 0,
        isUsed: false,
        ...baseFields(now),
      },
    });
    return code;
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

    const valid = safeHashEquals(otp.codeHash, hashCode(code));
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

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').toUpperCase();
}

function safeHashEquals(stored: string, presented: string): boolean {
  const left = Buffer.from(stored);
  const right = Buffer.from(presented);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
