import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AppException } from '../../common/exceptions/app.exception';
import { utcNow } from '../../common/utils/date.util';

export interface VerifiedPhone {
  uid: string;
  phone: string;
}

type PhoneUser = {
  id: string;
  phone: string;
  firebasePhoneUid: string | null;
};

@Injectable()
export class PhoneAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveExisting(identity: VerifiedPhone): Promise<PhoneUser | null> {
    const byUid = await this.prisma.user.findFirst({
      where: { firebasePhoneUid: identity.uid, isDeleted: false },
      select: { id: true, phone: true, firebasePhoneUid: true },
    });
    const byPhone = await this.prisma.user.findFirst({
      where: { phone: identity.phone, isDeleted: false },
      select: { id: true, phone: true, firebasePhoneUid: true },
    });

    if (byUid && byPhone && byUid.id !== byPhone.id) {
      throw new AppException(
        'لا يمكن دمج حسابين موجودين',
        409,
        'ACCOUNT_MERGE_BLOCKED',
      );
    }
    if (byUid && !byPhone) {
      throw new AppException(
        'حساب Firebase مرتبط برقم هاتف مختلف',
        409,
        'FIREBASE_UID_PHONE_CONFLICT',
      );
    }
    if (
      byPhone?.firebasePhoneUid &&
      byPhone.firebasePhoneUid !== identity.uid
    ) {
      throw new AppException(
        'رقم الهاتف مرتبط بحساب Firebase آخر',
        409,
        'PHONE_UID_CONFLICT',
      );
    }
    return byPhone;
  }

  async bindUidIfMissing(user: PhoneUser, uid: string): Promise<void> {
    if (user.firebasePhoneUid === uid) return;
    if (user.firebasePhoneUid && user.firebasePhoneUid !== uid) {
      throw new AppException(
        'رقم الهاتف مرتبط بحساب Firebase آخر',
        409,
        'PHONE_UID_CONFLICT',
      );
    }
    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { firebasePhoneUid: uid, updatedAt: utcNow() },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppException(
          'حساب Firebase مرتبط بحساب آخر',
          409,
          'FIREBASE_UID_CONFLICT',
        );
      }
      throw error;
    }
  }
}
