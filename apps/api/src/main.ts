import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';
import { loadRootEnvFile } from './config/load-env-file.js';

async function bootstrap(): Promise<void> {
  loadRootEnvFile();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);
  configureApp(app, config);
  await app.listen(config.port);
  Logger.log(`COOBRA API listening on http://localhost:${config.port}`, 'Bootstrap');
}

await bootstrap();
