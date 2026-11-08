import { Injectable } from '@nestjs/common';
import { AccountKind, EntryType } from '@prisma/client';
import { conflict, DomainError, notFound } from '../common/errors';
import { formatAmount, parseAmount } from '../common/money';
import { IdempotencyService } from '../ledger/idempotency.service';
import { LedgerService, SYSTEM_ACCOUNTS } from '../ledger/ledger.service';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface WalletAccounts {
  walletId: string;
  available: string;
  held: string;
}

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(ownerId: string) {
    const existing = await this.prisma.wallet.findUnique({ where: { ownerId } });
    if (existing) throw conflict('WALLET_EXISTS', `a wallet already exists for ${ownerId}`);
    await this.prisma.wallet.create({
      data: {
        ownerId,
        accounts: {
          create: [
            { code: `wallet:${ownerId}:available`, kind: AccountKind.AVAILABLE },
            { code: `wallet:${ownerId}:held`, kind: AccountKind.HELD },
          ],
        },
      },
    });
    return this.balances(ownerId);
  }

  async balances(ownerId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { ownerId }, include: { accounts: true } });
    if (!wallet) throw notFound(`wallet for ${ownerId}`);
    const balance = (kind: AccountKind) => wallet.accounts.find((a) => a.kind === kind)!.balance;
    const available = balance(AccountKind.AVAILABLE);
    const held = balance(AccountKind.HELD);
    return {
      ownerId,
      currency: 'USD',
      available: formatAmount(available),
      held: formatAmount(held),
      total: formatAmount(available + held),
    };
  }

  /** Journal history for a wallet's accounts, newest first. */
  async history(ownerId: string, limit = 50) {
    const wallet = await this.prisma.wallet.findUnique({ where: { ownerId }, include: { accounts: true } });
    if (!wallet) throw notFound(`wallet for ${ownerId}`);
    const postings = await this.prisma.posting.findMany({
      where: { accountId: { in: wallet.accounts.map((a) => a.id) } },
      include: { entry: true, account: true },
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return postings.map((p) => ({
      entryId: p.entryId,
      type: p.entry.type,
      account: p.account.kind,
      amount: formatAmount(p.amount),
      at: p.createdAt.toISOString(),
    }));
  }

  deposit(key: string, ownerId: string, amountInput: string) {
    const amount = parseAmount(amountInput);
    return this.idempotency.run(key, 'deposit', { ownerId, amount: amountInput }, async (tx) => {
      const wallet = await this.accounts(tx, ownerId);
      const source = await this.ledger.systemAccountId(tx, SYSTEM_ACCOUNTS.deposits);
      const entry = await this.ledger.post(tx, {
        type: EntryType.DEPOSIT,
        lines: [
          { accountId: source, amount: -amount },
          { accountId: wallet.available, amount },
        ],
      });
      return { entryId: entry.id, ownerId, amount: formatAmount(amount) };
    });
  }

  withdraw(key: string, ownerId: string, amountInput: string) {
    const amount = parseAmount(amountInput);
    return this.idempotency.run(key, 'withdrawal', { ownerId, amount: amountInput }, async (tx) => {
      const wallet = await this.accounts(tx, ownerId);
      const sink = await this.ledger.systemAccountId(tx, SYSTEM_ACCOUNTS.withdrawals);
      const entry = await this.ledger.post(tx, {
        type: EntryType.WITHDRAWAL,
        lines: [
          { accountId: wallet.available, amount: -amount },
          { accountId: sink, amount },
        ],
      });
      return { entryId: entry.id, ownerId, amount: formatAmount(amount) };
    });
  }

  transfer(key: string, fromOwnerId: string, toOwnerId: string, amountInput: string) {
    if (fromOwnerId === toOwnerId) {
      throw new DomainError('SAME_WALLET', 'cannot transfer to the same wallet', 422);
    }
    const amount = parseAmount(amountInput);
    return this.idempotency.run(key, 'transfer', { fromOwnerId, toOwnerId, amount: amountInput }, async (tx) => {
      const from = await this.accounts(tx, fromOwnerId);
      const to = await this.accounts(tx, toOwnerId);
      const entry = await this.ledger.post(tx, {
        type: EntryType.TRANSFER,
        lines: [
          { accountId: from.available, amount: -amount },
          { accountId: to.available, amount },
        ],
      });
      return { entryId: entry.id, fromOwnerId, toOwnerId, amount: formatAmount(amount) };
    });
  }

  /** Account ids for a wallet. Balances are read later, under lock, by the ledger. */
  async accounts(tx: Tx, ownerId: string): Promise<WalletAccounts> {
    const wallet = await tx.wallet.findUnique({ where: { ownerId }, include: { accounts: true } });
    if (!wallet) throw notFound(`wallet for ${ownerId}`);
    const id = (kind: AccountKind) => wallet.accounts.find((a) => a.kind === kind)!.id;
    return { walletId: wallet.id, available: id(AccountKind.AVAILABLE), held: id(AccountKind.HELD) };
  }
}
