import { Injectable } from '@nestjs/common';
import { EntryType, HoldStatus } from '@prisma/client';
import { conflict, notFound } from '../common/errors';
import { formatAmount, parseAmount } from '../common/money';
import { IdempotencyService } from '../ledger/idempotency.service';
import { LedgerService } from '../ledger/ledger.service';
import { Tx } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';

interface LockedHold {
  id: string;
  wallet_id: string;
  amount: bigint;
  status: HoldStatus;
}

/**
 * A hold reserves funds, like an open order. Reserving is itself a ledger entry
 * (available -> held), so reserved money is always visible in the ledger.
 * An open hold ends exactly once: captured to a recipient, or released back.
 */
@Injectable()
export class HoldsService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  place(key: string, ownerId: string, amountInput: string) {
    const amount = parseAmount(amountInput);
    return this.idempotency.run(key, 'hold', { ownerId, amount: amountInput }, async (tx) => {
      const wallet = await this.wallets.accounts(tx, ownerId);
      const entry = await this.ledger.post(tx, {
        type: EntryType.HOLD,
        lines: [
          { accountId: wallet.available, amount: -amount },
          { accountId: wallet.held, amount },
        ],
      });
      const hold = await tx.hold.create({ data: { walletId: wallet.walletId, amount, holdEntryId: entry.id } });
      return this.view(hold.id, ownerId, amount, HoldStatus.OPEN);
    });
  }

  capture(key: string, holdId: string, toOwnerId: string) {
    return this.idempotency.run(key, 'hold.capture', { holdId, toOwnerId }, async (tx) => {
      const { hold, ownerId } = await this.lockOpenHold(tx, holdId);
      const payer = await this.wallets.accounts(tx, ownerId);
      const payee = await this.wallets.accounts(tx, toOwnerId);
      const entry = await this.ledger.post(tx, {
        type: EntryType.CAPTURE,
        lines: [
          { accountId: payer.held, amount: -hold.amount },
          { accountId: payee.available, amount: hold.amount },
        ],
      });
      await tx.hold.update({ where: { id: holdId }, data: { status: HoldStatus.CAPTURED, settleEntryId: entry.id } });
      return { ...this.view(holdId, ownerId, hold.amount, HoldStatus.CAPTURED), toOwnerId };
    });
  }

  release(key: string, holdId: string) {
    return this.idempotency.run(key, 'hold.release', { holdId }, async (tx) => {
      const { hold, ownerId } = await this.lockOpenHold(tx, holdId);
      const wallet = await this.wallets.accounts(tx, ownerId);
      const entry = await this.ledger.post(tx, {
        type: EntryType.RELEASE,
        lines: [
          { accountId: wallet.held, amount: -hold.amount },
          { accountId: wallet.available, amount: hold.amount },
        ],
      });
      await tx.hold.update({ where: { id: holdId }, data: { status: HoldStatus.RELEASED, settleEntryId: entry.id } });
      return this.view(holdId, ownerId, hold.amount, HoldStatus.RELEASED);
    });
  }

  /** Locks the hold row so it can only be captured or released once. */
  private async lockOpenHold(tx: Tx, holdId: string) {
    const [hold] = await tx.$queryRaw<LockedHold[]>`
      SELECT id, wallet_id, amount, status FROM holds WHERE id = ${holdId}::uuid FOR UPDATE`;
    if (!hold) throw notFound(`hold ${holdId}`);
    if (hold.status !== HoldStatus.OPEN) {
      throw conflict('HOLD_NOT_OPEN', `hold is already ${hold.status.toLowerCase()}`);
    }
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.wallet_id } });
    return { hold, ownerId: wallet.ownerId };
  }

  private view(id: string, ownerId: string, amount: bigint, status: HoldStatus) {
    return { holdId: id, ownerId, amount: formatAmount(amount), status };
  }
}
