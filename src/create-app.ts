import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  ExpressAdapter,
  NestExpressApplication,
} from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { driverTripsRateLimit } from './common/middleware/driver-trips-rate-limit';

const DEFAULT_ORIGINS = [
  'https://shuttlez.org',
  'https://www.shuttlez.org',
  'https://shuttlez-dashboard.web.app',
  'https://shuttlez-dashboard.firebaseapp.com',
  'https://shuttlez-landing.web.app',
  'https://shuttlez-landing.firebaseapp.com',
  'https://shuttlez-api.web.app',
  'https://shuttlez-api.firebaseapp.com',
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
    allowedHeaders: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      forbidNonWhitelisted: false,
    }),
  );

  const uploadDir = config.get<string>('UPLOAD_DIR') ?? 'uploads';
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }
  app.useStaticAssets(join(process.cwd(), uploadDir), { prefix: '/uploads' });

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
