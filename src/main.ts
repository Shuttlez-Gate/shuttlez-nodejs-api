import { ConfigService } from '@nestjs/config';
import { createNestApp } from './create-app';

async function bootstrap(): Promise<void> {
  const app = await createNestApp();
  const config = app.get(ConfigService);
  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port);
}

void bootstrap();
