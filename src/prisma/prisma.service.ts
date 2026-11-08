import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs work in a READ COMMITTED transaction. Correctness comes from explicit row
   * locks (SELECT ... FOR UPDATE) taken in a fixed order, plus database constraints.
   *
   * Deferred constraints (the balanced-entry check) are forced to run before
   * COMMIT. Prisma 5 does not surface errors raised during COMMIT: the transaction
   * rolls back but the promise resolves, which would report success for money that
   * never moved. Checking here turns that into a normal, catchable error.
   */
  inTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        const result = await work(tx);
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 10_000,
      },
    );
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
