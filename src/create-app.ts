import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  ExpressAdapter,
  NestExpressApplication,
} from '@nestjs/platform-express';
import { isAbsolute, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { driverTripsRateLimit } from './common/middleware/driver-trips-rate-limit';

const logger = new Logger('CreateApp');

function isServerlessRuntime(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT,
  );
}

function resolveUploadDir(config: ConfigService): string {
  const configured = config.get<string>('UPLOAD_DIR')?.trim();
  if (isServerlessRuntime()) {
    if (configured && configured.startsWith('/tmp')) {
      return configured;
    }
    return join('/tmp', configured || 'uploads');
  }
  return configured || 'uploads';
}

const DEFAULT_ORIGINS = [
  'https://shuttlez.org',
  'https://www.shuttlez.org',
  'http://localhost:4200',
  'https://localhost:4200',
  'http://localhost:4300',
  'https://localhost:4300',
  'http://127.0.0.1:4200',
  'https://127.0.0.1:4200',
  'http://127.0.0.1:4300',
  'https://127.0.0.1:4300',
  'https://shuttlez-dashboard.web.app',
  'https://shuttlez-dashboard.firebaseapp.com',
  'https://shuttlez-landing.web.app',
  'https://shuttlez-landing.firebaseapp.com',
  'https://shuttlez-api.web.app',
  'https://shuttlez-api.firebaseapp.com',
  'https://shuttlez-nodejs-api.vercel.app',
];

const CORS_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'Accept-Language',
  'Origin',
  'X-Requested-With',
  'X-Access-Token',
];

export async function createNestApp(
  expressInstance?: Express,
): Promise<NestExpressApplication> {
  const app = expressInstance
    ? await NestFactory.create<NestExpressApplication>(
        AppModule,
        new ExpressAdapter(expressInstance),
      )
    : await NestFactory.create<NestExpressApplication>(AppModule);

  const config = app.get(ConfigService);

  const origins = (config.get<string>('CORS_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowed = origins.length > 0 ? origins : DEFAULT_ORIGINS;

  app.enableCors({
    origin: allowed,
    credentials: true,
    allowedHeaders: CORS_HEADERS,
    exposedHeaders: ['Content-Type'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      forbidNonWhitelisted: false,
    }),
  );

  const uploadDir = resolveUploadDir(config);
  try {
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }
    const assetsRoot = isAbsolute(uploadDir)
      ? uploadDir
      : join(process.cwd(), uploadDir);
    app.useStaticAssets(assetsRoot, { prefix: '/uploads' });
  } catch (err) {
    logger.warn(
      `Skipping upload directory "${uploadDir}": ${(err as Error).message}`,
    );
  }

  app.use(driverTripsRateLimit);

  const swagger = new DocumentBuilder()
    .setTitle('Shuttlez API')
    .setVersion('v1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'Bearer',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('swagger', app, document);

  return app;
}
