import { ConfigService } from '@nestjs/config';
import { createNestApp } from './create-app';

async function bootstrap(): Promise<void> {
  const app = await createNestApp();
  const config = app.get(ConfigService);
  const port = Number(config.get('PORT') ?? 3000);
  // 0.0.0.0 so a phone on the same LAN can reach the API, not only localhost.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
