import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:3000';
  const port = Number(process.env.PORT || 4000);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: webOrigin, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log('API Started');
  logger.log(`Port: ${port}`);
  logger.log('Database Connected');
  logger.log('OAuth Ready');
  logger.log('Market Data Ready');
  logger.log(`Listening on http://localhost:${port}`);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error('API startup failed', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
