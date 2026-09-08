import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, UnauthorizedAppException } from '../../common/exceptions/app.exception';
import { normalizeSocialProvider } from '../../modules/auth/auth.mapper';

export interface VerifiedSocialIdentity {
  provider: string;
  providerUserId: string;
  displayName?: string | null;
  email?: string | null;
  photoUrl?: string | null;
}

@Injectable()
export class FirebaseTokenVerifier {
  private readonly logger = new Logger(FirebaseTokenVerifier.name);
  private appPromise: Promise<unknown> | null = null;

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
      const credentialsPath =
        this.config.get<string>('FIREBASE_CREDENTIALS_PATH') ??
        process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (credentialsPath) {
        const fs = await import('fs');
        if (!fs.existsSync(credentialsPath)) {
          this.logger.warn(
            `Firebase credentials file not found: ${credentialsPath}`,
          );
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
