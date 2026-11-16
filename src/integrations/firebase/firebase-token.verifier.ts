import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, UnauthorizedAppException } from '../../common/exceptions/app.exception';
import { normalizePhone } from '../../common/utils/phone-normalizer';
import { normalizeSocialProvider } from '../../modules/auth/auth.mapper';

export interface VerifiedSocialIdentity {
  provider: string;
  providerUserId: string;
  displayName?: string | null;
  email?: string | null;
  photoUrl?: string | null;
}

export interface VerifiedPhoneIdentity {
  uid: string;
  phone: string;
  expiresAt: number;
}

@Injectable()
export class FirebaseTokenVerifier {
  private readonly logger = new Logger(FirebaseTokenVerifier.name);
  private appPromise: Promise<unknown> | null = null;
  private readonly usedPhoneTokens = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  async verify(
    provider: string,
    firebaseIdToken: string,
  ): Promise<VerifiedSocialIdentity> {
    const normalizedProvider = normalizeSocialProvider(provider);
    const app = await this.getApp();
    if (!app) {
      throw new AppException(
        'خدمة تسجيل الدخول الاجتماعي غير مهيأة على الخادم',
        503,
        'SOCIAL_AUTH_NOT_CONFIGURED',
      );
    }

    try {
      const admin = await import('firebase-admin');
      const decoded = await admin.auth(app as never).verifyIdToken(firebaseIdToken);
      const firebaseClaim = decoded.firebase as
        | { sign_in_provider?: string }
        | undefined;
      const signInProvider = firebaseClaim?.sign_in_provider;
      if (
        !signInProvider ||
        signInProvider.toLowerCase() !== normalizedProvider.toLowerCase()
      ) {
        throw new UnauthorizedAppException(
          'نوع مزود تسجيل الدخول لا يطابق الرمز المرسل',
          'FIREBASE_PROVIDER_MISMATCH',
        );
      }

      return {
        provider: normalizedProvider,
        providerUserId: decoded.uid,
        displayName: decoded.name ?? null,
        email: decoded.email ?? null,
        photoUrl: decoded.picture ?? null,
      };
    } catch (err) {
      if (err instanceof AppException) {
        throw err;
      }
      throw new UnauthorizedAppException(
        'رمز Firebase غير صالح أو منتهي الصلاحية',
        'FIREBASE_TOKEN_INVALID',
      );
    }
  }

  async verifyPhone(firebaseIdToken: string): Promise<VerifiedPhoneIdentity> {
    const app = await this.getApp();
    if (!app) {
      throw new AppException(
        'خدمة التحقق من الهاتف غير مهيأة على الخادم',
        503,
        'FIREBASE_PHONE_NOT_CONFIGURED',
      );
    }

    try {
      const admin = await import('firebase-admin');
      const decoded = await admin
        .auth(app as never)
        .verifyIdToken(firebaseIdToken, true);
      const firebaseClaim = decoded.firebase as
        | { sign_in_provider?: string }
        | undefined;
      if (firebaseClaim?.sign_in_provider !== 'phone') {
        throw new UnauthorizedAppException(
          'رمز التحقق ليس ناتجاً عن توثيق الهاتف',
          'FIREBASE_PROVIDER_MISMATCH',
        );
      }
      const projectId =
        this.config.get<string>('FIREBASE_PROJECT_ID') || 'shuttlez-api';
      if (decoded.aud !== projectId || !decoded.uid || !decoded.exp) {
        throw new UnauthorizedAppException(
          'رمز Firebase غير صالح',
          'FIREBASE_TOKEN_INVALID',
        );
      }
      const phone =
        typeof decoded.phone_number === 'string'
          ? normalizePhone(decoded.phone_number)
          : '';
      if (!phone.startsWith('+')) {
        throw new UnauthorizedAppException(
          'رمز الهاتف لا يحتوي على رقم موثّق',
          'FIREBASE_PHONE_MISSING',
        );
      }
      return { uid: decoded.uid, phone, expiresAt: decoded.exp };
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw new UnauthorizedAppException(
        'رمز Firebase غير صالح أو منتهي الصلاحية',
        'FIREBASE_TOKEN_INVALID',
      );
    }
  }

  consumePhoneToken(firebaseIdToken: string, expiresAt: number): void {
    const now = Date.now();
    for (const [key, expiry] of this.usedPhoneTokens) {
      if (expiry <= now) this.usedPhoneTokens.delete(key);
    }
    const key = createHash('sha256').update(firebaseIdToken, 'utf8').digest('hex');
    const seenUntil = this.usedPhoneTokens.get(key) ?? 0;
    if (seenUntil > now) {
      throw new UnauthorizedAppException(
        'تم استخدام رمز التحقق من قبل',
        'FIREBASE_TOKEN_REPLAY',
      );
    }
    this.usedPhoneTokens.set(key, expiresAt * 1000);
  }

  private async getApp(): Promise<unknown> {
    if (!this.appPromise) {
      this.appPromise = this.createApp();
    }
    return this.appPromise;
  }



  private async createApp(): Promise<unknown> {
    try {
      const admin = await import('firebase-admin');

      if (admin.apps.length > 0) {
        return admin.apps[0];
      }

      const projectId =
        this.config.get<string>('FIREBASE_PROJECT_ID') || 'shuttlez-api';

      // Preferred: service account JSON stored securely in Vercel.
      const serviceAccountJson = this.config.get<string>(
        'FIREBASE_SERVICE_ACCOUNT_JSON',
      );

      if (serviceAccountJson) {
        const serviceAccount = JSON.parse(serviceAccountJson);

        if (serviceAccount.project_id !== projectId) {
          throw new Error(
            'Firebase service account project_id does not match FIREBASE_PROJECT_ID',
          );
        }

        return admin.initializeApp(
          {
            credential: admin.credential.cert(serviceAccount),
            projectId,
          },
          'ShuttlezSocialAuth',
        );
      }

      // Backward compatibility: credentials file path.
      const credentialsPath =
        this.config.get<string>('FIREBASE_CREDENTIALS_PATH') ??
        process.env.GOOGLE_APPLICATION_CREDENTIALS;

      if (credentialsPath) {
        const fs = await import('fs');

        if (!fs.existsSync(credentialsPath)) {
          this.logger.warn('Firebase credentials file not found');
          return null;
        }

        return admin.initializeApp(
          {
            credential: admin.credential.cert(credentialsPath),
            projectId,
          },
          'ShuttlezSocialAuth',
        );
      }

      const onGcp = Boolean(
        process.env.FUNCTION_TARGET ||
          process.env.K_SERVICE ||
          process.env.FIREBASE_CONFIG,
      );

      if (!onGcp) {
        return null;
      }

      return admin.initializeApp({ projectId }, 'ShuttlezSocialAuth');
    } catch (err) {
      this.logger.error('Failed to initialize Firebase', err as Error);
      return null;
    }
  }


}
