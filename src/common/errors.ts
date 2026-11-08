import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { InvalidAmountError } from './money';

/** A business rule was broken. Each one maps to a stable error code for clients. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const insufficientFunds = (account: string) =>
  new DomainError('INSUFFICIENT_FUNDS', `insufficient funds in ${account}`, HttpStatus.UNPROCESSABLE_ENTITY);
export const notFound = (what: string) =>
  new DomainError('NOT_FOUND', `${what} not found`, HttpStatus.NOT_FOUND);
export const conflict = (code: string, message: string) =>
  new DomainError(code, message, HttpStatus.CONFLICT);

/** Postgres SQLSTATE codes raised by the ledger's own constraints and triggers. */
const LEDGER_CONSTRAINT_CODES = new Set(['23514', '23001']);

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, code, message] = this.describe(error);
    if (status >= 500) this.logger.error(error);
    res.status(status).json({ error: { code, message } });
  }

  private describe(error: unknown): [number, string, string] {
    if (error instanceof DomainError) return [error.status, error.code, error.message];
    if (error instanceof InvalidAmountError) return [400, 'INVALID_AMOUNT', error.message];
    if (error instanceof HttpException) {
      const body = error.getResponse();
      const message =
        typeof body === 'object' && body && 'message' in body
          ? [body.message].flat().join('; ')
          : error.message;
      return [error.getStatus(), 'BAD_REQUEST', message];
    }
    // The database is the last line of defence; if it rejects a write, never report success.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') return [409, 'CONFLICT', 'resource already exists'];
      const sqlState = (error.meta as { code?: string } | undefined)?.code;
      if (sqlState && LEDGER_CONSTRAINT_CODES.has(sqlState)) {
        return [409, 'LEDGER_CONSTRAINT', 'the ledger rejected this change'];
      }
    }
    return [500, 'INTERNAL', 'internal error'];
  }
}
