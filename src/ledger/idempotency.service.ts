import { BadRequestException, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { conflict } from '../common/errors';
import { PrismaService, Tx } from '../prisma/prisma.service';

/** Reads the required Idempotency-Key header. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const key = ctx.switchToHttp().getRequest().headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    throw new BadRequestException('Idempotency-Key header is required (8 to 128 characters)');
  }
  return key;
});

export interface IdempotentResult<T> {
  body: T;
  replayed: boolean;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs a money operation at most once per key.
   *
   * The key is claimed with an INSERT in the same transaction as the operation. A
   * concurrent request with the same key blocks on that row until the first one
   * commits (then it replays the stored response) or rolls back (then it runs).
   * Reusing a key with a different request is rejected.
   */
  async run<T extends object>(
    key: string,
    scope: string,
    request: unknown,
    operation: (tx: Tx) => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = createHash('sha256').update(stableStringify({ scope, request })).digest('hex');

    return this.prisma.inTransaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        INSERT INTO idempotency_records (key, scope, request_hash, status_code, response_body)
        VALUES (${key}, ${scope}, ${requestHash}, 0, '{}'::jsonb)
        ON CONFLICT (key) DO NOTHING`;

      if (claimed === 0) {
        const existing = await tx.idempotencyRecord.findUniqueOrThrow({ where: { key } });
        if (existing.requestHash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used for a different request');
        }
        return { body: existing.responseBody as T, replayed: true };
      }

      const body = await operation(tx);
      await tx.idempotencyRecord.update({
        where: { key },
        data: { statusCode: 201, responseBody: body as Prisma.InputJsonObject },
      });
      return { body, replayed: false };
    });
  }
}

/** JSON with sorted keys, so the same request always hashes the same way. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
