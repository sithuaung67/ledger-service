import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HoldsController, LedgerController, WalletsController } from './api.controllers';
import { ErrorFilter } from './common/errors';
import { HoldsService } from './holds/holds.service';
import { IdempotencyService } from './ledger/idempotency.service';
import { LedgerService } from './ledger/ledger.service';
import { PrismaModule } from './prisma/prisma.service';
import { WalletsService } from './wallets/wallets.service';

@Module({
  imports: [PrismaModule],
  controllers: [WalletsController, HoldsController, LedgerController],
  providers: [LedgerService, IdempotencyService, WalletsService, HoldsService, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}

/** Shared by main.ts and the e2e tests, so tests run the same pipeline as production. */
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  app.enableShutdownHooks();
  const doc = new DocumentBuilder()
    .setTitle('Ledger Service')
    .setDescription('Double-entry wallet ledger: deposits, withdrawals, transfers and holds.')
    .setVersion('1.0.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  return app;
}
