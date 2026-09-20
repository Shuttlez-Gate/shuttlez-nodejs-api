import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma/prisma.service';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);
  private appPromise: Promise<unknown> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async notifyUser(
    userId: string,
    title: string,
    body: string,
    type: string,
    data: Record<string, string> = {},
  ): Promise<void> {
    await this.prisma.notification.create({
      data: {
        id: newId(),
        userId,
        title,
        body,
        type,
        isRead: false,
        ...baseFields(),
      },
    });

    const devices = await this.prisma.userDevice.findMany({
      where: { userId, isActive: true, isDeleted: false },
    });
    const tokens = [...new Set(devices.map((item) => item.token).filter(Boolean))];
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
      select: { fcmToken: true },
    });
    if (user?.fcmToken && !tokens.includes(user.fcmToken)) {
      tokens.push(user.fcmToken);
    }
    if (tokens.length === 0) {
      return;
    }

    const app = await this.getApp();
    if (!app) {
      this.logger.warn('FCM skipped: Firebase admin is not configured');
      return;
    }

    try {
      const admin = await import('firebase-admin');
      const response = await admin.messaging(app as never).sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { type, ...stringifyData(data) },
      });
      const invalid: string[] = [];
      response.responses.forEach((item, index) => {
        if (item.success) {
          return;
        }
        const code = item.error?.code ?? '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token')
        ) {
          invalid.push(tokens[index]);
        }
      });
      if (invalid.length > 0) {
        await this.prisma.userDevice.updateMany({
          where: { userId, token: { in: invalid } },
          data: { isActive: false, updatedAt: utcNow() },
        });
      }
    } catch (err) {
      this.logger.warn(`FCM send failed for ${userId}: ${(err as Error).message}`);
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
          this.logger.warn(`Firebase credentials file not found: ${credentialsPath}`);
          return null;
        }
        return admin.initializeApp(
          {
            credential: admin.credential.cert(credentialsPath),
            projectId,
          },
          'ShuttlezPush',
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
      return admin.initializeApp({ projectId }, 'ShuttlezPush');
    } catch (err) {
      this.logger.error('Failed to initialize Firebase for FCM', err as Error);
      return null;
    }
  }
}

function stringifyData(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value != null) {
      out[key] = String(value);
    }
  }
  return out;
}
