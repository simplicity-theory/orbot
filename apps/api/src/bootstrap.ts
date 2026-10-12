import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { RedactingLogger } from './redaction/redacting-logger.js';

/** Builds the Nest app. Shared by `main.ts`, the seed script and the e2e tests. */
export async function createApp(opts: AppModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(opts), { bufferLogs: true });
  app.useLogger(app.get(RedactingLogger));
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.disable('x-powered-by');
  app.enableCors({ origin: opts.config.webOrigin, credentials: true });
  app.enableShutdownHooks();
  return app;
}
