import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountKind, EntryType } from '@prisma/client';
import { DomainError, insufficientFunds } from '../common/errors';
import { PrismaService, Tx } from '../prisma/prisma.service';

/** Platform accounts on the other side of money entering and leaving the system. */
export const SYSTEM_ACCOUNTS = {
  deposits: 'system:deposits',
  withdrawals: 'system:withdrawals',
} as const;

export interface PostingLine {
  accountId: string;
  /** Signed cents: positive increases the account balance. */
  amount: bigint;
}

export interface PostInput {
  type: EntryType;
  description?: string;
  lines: PostingLine[];
}

interface LockedAccount {
  id: string;
  code: string;
  balance: bigint;
  allow_negative: boolean;
}

@Injectable()
export class LedgerService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    for (const code of Object.values(SYSTEM_ACCOUNTS)) {
      await this.prisma.account.upsert({
        where: { code },
        update: {},
        create: { code, kind: AccountKind.SYSTEM, allowNegative: true },
      });
    }
  }

  async systemAccountId(tx: Tx, code: string): Promise<string> {
    const account = await tx.account.findUniqueOrThrow({ where: { code }, select: { id: true } });
    return account.id;
  }

  /**
   * Writes one balanced journal entry and updates cached balances, inside the
   * caller's transaction. Must be the only code path that changes a balance.
   */
  async post(tx: Tx, input: PostInput) {
    const deltas = this.validate(input.lines);
    const ids = [...deltas.keys()].sort();

    // Lock every touched account in id order. A fixed lock order means two
    // concurrent entries over the same accounts can never deadlock.
    const locked = await tx.$queryRaw<LockedAccount[]>`
      SELECT id, code, balance, allow_negative
        FROM accounts
       WHERE id = ANY(${ids}::uuid[])
       ORDER BY id
         FOR UPDATE`;
    if (locked.length !== ids.length) {
      throw new DomainError('UNKNOWN_ACCOUNT', 'posting references an unknown account', 422);
    }

    for (const account of locked) {
      const next = account.balance + deltas.get(account.id)!;
      if (!account.allow_negative && next < 0n) throw insufficientFunds(account.code);
    }

    const entry = await tx.journalEntry.create({
      data: { type: input.type, description: input.description },
    });
    await tx.posting.createMany({
      data: input.lines.map((line) => ({ entryId: entry.id, accountId: line.accountId, amount: line.amount })),
    });
    for (const [accountId, delta] of deltas) {
      await tx.$executeRaw`UPDATE accounts SET balance = balance + ${delta} WHERE id = ${accountId}::uuid`;
    }
    return entry;
  }

  /** Returns the net change per account; rejects entries that do not balance. */
  private validate(lines: PostingLine[]): Map<string, bigint> {
    if (lines.length < 2) throw new Error('a journal entry needs at least two postings');
    let total = 0n;
    const deltas = new Map<string, bigint>();
    for (const { accountId, amount } of lines) {
      if (typeof amount !== 'bigint' || amount === 0n) throw new Error('posting amounts must be non-zero bigints');
      total += amount;
      deltas.set(accountId, (deltas.get(accountId) ?? 0n) + amount);
    }
    if (total !== 0n) throw new Error(`journal entry does not balance (sum ${total})`);
    return deltas;
  }

  /**
   * Proves the ledger is consistent: all postings sum to zero, and every cached
   * balance equals the sum of that account's postings.
   */
  async checkInvariants() {
    const [{ total }] = await this.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM postings`;
    const drift = await this.prisma.$queryRaw<{ code: string; balance: bigint; derived: bigint }[]>`
      SELECT a.code, a.balance, COALESCE(SUM(p.amount), 0)::bigint AS derived
        FROM accounts a
        LEFT JOIN postings p ON p.account_id = a.id
       GROUP BY a.id
      HAVING a.balance <> COALESCE(SUM(p.amount), 0)`;
    const negative = await this.prisma.account.count({ where: { allowNegative: false, balance: { lt: 0 } } });
    return {
      ok: total === 0n && drift.length === 0 && negative === 0,
      postingsSum: total.toString(),
      accountsWithDrift: drift.map((d) => ({ code: d.code, balance: d.balance.toString(), derived: d.derived.toString() })),
      negativeBalances: negative,
    };
  }
}
