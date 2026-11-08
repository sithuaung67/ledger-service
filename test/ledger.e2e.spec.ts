import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('ledger (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let http: () => ReturnType<typeof request>;

  const key = () => randomUUID();
  const post = (path: string, body: object = {}, idempotencyKey = key()) =>
    http().post(path).set('Idempotency-Key', idempotencyKey).send(body);
  const balances = async (ownerId: string) => (await http().get(`/wallets/${ownerId}`).expect(200)).body;
  const wallet = async (ownerId: string, deposit?: string) => {
    await http().post('/wallets').send({ ownerId }).expect(201);
    if (deposit) await post(`/wallets/${ownerId}/deposits`, { amount: deposit }).expect(201);
  };
  const expectLedgerConsistent = async () => {
    const result = await ledger.checkInvariants();
    expect(result).toMatchObject({ ok: true, postingsSum: '0', accountsWithDrift: [], negativeBalances: 0 });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    // Listen once on a real port. Passing the bare server to supertest makes it
    // open and close a listener per request, which breaks under concurrent requests.
    await app.listen(0);
    const url = await app.getUrl();
    prisma = app.get(PrismaService);
    ledger = app.get(LedgerService);
    http = () => request(url.replace('[::1]', '127.0.0.1'));
  });

  beforeEach(async () => {
    // TRUNCATE bypasses the row-level immutability triggers; only tests may do this.
    await prisma.$executeRawUnsafe(
      'TRUNCATE postings, journal_entries, holds, accounts, wallets, idempotency_records RESTART IDENTITY CASCADE',
    );
    await ledger.onModuleInit();
  });

  afterEach(expectLedgerConsistent);
  afterAll(() => app.close());

  describe('deposits, withdrawals and transfers', () => {
    it('moves money and keeps balances as exact decimal strings', async () => {
      await wallet('alice', '100.10');
      await wallet('bob');
      await post('/transfers', { fromOwnerId: 'alice', toOwnerId: 'bob', amount: '0.10' }).expect(201);
      await post('/wallets/bob/withdrawals', { amount: '0.05' }).expect(201);

      expect(await balances('alice')).toMatchObject({ available: '100.00', held: '0.00' });
      expect(await balances('bob')).toMatchObject({ available: '0.05', total: '0.05' });
    });

    it('rejects overdrafts and leaves the balance unchanged', async () => {
      await wallet('alice', '10.00');
      const res = await post('/wallets/alice/withdrawals', { amount: '10.01' }).expect(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(await balances('alice')).toMatchObject({ available: '10.00' });
    });

    it.each([[0.1], ['0.001'], ['-5'], ['1e2']])('rejects the amount %j', async (amount) => {
      await wallet('alice');
      await post('/wallets/alice/deposits', { amount }).expect(400);
    });

    it('requires an Idempotency-Key on money endpoints', async () => {
      await wallet('alice');
      await http().post('/wallets/alice/deposits').send({ amount: '1.00' }).expect(400);
    });
  });

  describe('idempotency', () => {
    it('replays a retried request instead of moving money twice', async () => {
      await wallet('alice');
      const k = key();
      const first = await post('/wallets/alice/deposits', { amount: '25.00' }, k).expect(201);
      const retry = await post('/wallets/alice/deposits', { amount: '25.00' }, k).expect(201);

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await balances('alice')).toMatchObject({ available: '25.00' });
    });

    it('rejects a key reused for a different request', async () => {
      await wallet('alice');
      const k = key();
      await post('/wallets/alice/deposits', { amount: '25.00' }, k).expect(201);
      const res = await post('/wallets/alice/deposits', { amount: '26.00' }, k).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('applies the operation once when the same key arrives concurrently', async () => {
      await wallet('alice');
      const k = key();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => post('/wallets/alice/deposits', { amount: '5.00' }, k)),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.entryId)).size).toBe(1);
      expect(await balances('alice')).toMatchObject({ available: '5.00' });
    });

    it('lets a failed request be retried with the same key', async () => {
      await wallet('alice');
      const k = key();
      await post('/wallets/alice/withdrawals', { amount: '5.00' }, k).expect(422);
      await post('/wallets/alice/deposits', { amount: '5.00' }).expect(201);
      await post('/wallets/alice/withdrawals', { amount: '5.00' }, k).expect(201);
      expect(await balances('alice')).toMatchObject({ available: '0.00' });
    });
  });

  describe('concurrency', () => {
    it('never overdraws under 50 concurrent withdrawals', async () => {
      await wallet('alice', '100.00');
      const results = await Promise.all(
        Array.from({ length: 50 }, () => post('/wallets/alice/withdrawals', { amount: '10.00' })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(10);
      expect(results.filter((r) => r.status === 422)).toHaveLength(40);
      expect(await balances('alice')).toMatchObject({ available: '0.00' });
    });

    it('does not deadlock on transfers in opposite directions', async () => {
      await wallet('alice', '100.00');
      await wallet('bob', '100.00');
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          i % 2 === 0
            ? post('/transfers', { fromOwnerId: 'alice', toOwnerId: 'bob', amount: '1.00' })
            : post('/transfers', { fromOwnerId: 'bob', toOwnerId: 'alice', amount: '1.00' }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await balances('alice')).toMatchObject({ available: '100.00' });
      expect(await balances('bob')).toMatchObject({ available: '100.00' });
    });

    it('keeps the ledger consistent under a random concurrent workload', async () => {
      const owners = ['a', 'b', 'c', 'd'];
      for (const o of owners) await wallet(o, '50.00');
      let seed = 42;
      const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;

      await Promise.all(
        Array.from({ length: 80 }, () => {
          const from = owners[rand(4)];
          const to = owners[(owners.indexOf(from) + 1 + rand(3)) % 4];
          const amount = `${1 + rand(20)}.${rand(100).toString().padStart(2, '0')}`;
          return [
            () => post('/transfers', { fromOwnerId: from, toOwnerId: to, amount }),
            () => post(`/wallets/${from}/withdrawals`, { amount }),
            () => post(`/wallets/${from}/holds`, { amount }),
          ][rand(3)]();
        }),
      );

      const totals = await Promise.all(owners.map(balances));
      for (const t of totals) expect(Number(t.available)).toBeGreaterThanOrEqual(0);
      // Consistency itself is asserted by afterEach.
    });
  });

  describe('holds (fund reservations)', () => {
    it('reserves funds, then captures them to another wallet', async () => {
      await wallet('alice', '50.00');
      await wallet('bob');
      const hold = (await post('/wallets/alice/holds', { amount: '20.00' }).expect(201)).body;
      expect(await balances('alice')).toMatchObject({ available: '30.00', held: '20.00', total: '50.00' });

      await post(`/holds/${hold.holdId}/capture`, { toOwnerId: 'bob' }).expect(201);
      expect(await balances('alice')).toMatchObject({ available: '30.00', held: '0.00' });
      expect(await balances('bob')).toMatchObject({ available: '20.00' });
    });

    it('releases funds back to the owner', async () => {
      await wallet('alice', '50.00');
      const hold = (await post('/wallets/alice/holds', { amount: '20.00' }).expect(201)).body;
      await post(`/holds/${hold.holdId}/release`).expect(201);
      expect(await balances('alice')).toMatchObject({ available: '50.00', held: '0.00' });
    });

    it('cannot reserve more than the available balance', async () => {
      await wallet('alice', '10.00');
      await post('/wallets/alice/holds', { amount: '6.00' }).expect(201);
      await post('/wallets/alice/holds', { amount: '6.00' }).expect(422);
    });

    it('settles a hold exactly once when capture and release race', async () => {
      await wallet('alice', '50.00');
      await wallet('bob');
      const hold = (await post('/wallets/alice/holds', { amount: '20.00' }).expect(201)).body;
      const results = await Promise.all([
        ...Array.from({ length: 5 }, () => post(`/holds/${hold.holdId}/capture`, { toOwnerId: 'bob' })),
        ...Array.from({ length: 5 }, () => post(`/holds/${hold.holdId}/release`)),
      ]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      const alice = await balances('alice');
      const bob = await balances('bob');
      expect(alice.held).toBe('0.00');
      expect(Number(alice.available) + Number(bob.available)).toBe(50);
    });
  });

  describe('database guarantees', () => {
    it('rejects updates and deletes of journal postings', async () => {
      await wallet('alice', '10.00');
      await expect(prisma.$executeRawUnsafe('UPDATE postings SET amount = amount * 2')).rejects.toThrow(/immutable/);
      await expect(prisma.$executeRawUnsafe('DELETE FROM journal_entries')).rejects.toThrow(/immutable/);
    });

    it('rejects an unbalanced journal entry written around the ledger service', async () => {
      await wallet('alice');
      const [account] = await prisma.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM accounts WHERE code = 'wallet:alice:available'",
      );
      const writeUnbalanced = async (tx: Parameters<Parameters<PrismaService['inTransaction']>[0]>[0]) => {
        const entry = await tx.journalEntry.create({ data: { type: 'DEPOSIT' } });
        await tx.posting.create({ data: { entryId: entry.id, accountId: account.id, amount: 500n } });
      };

      // Through the service's transaction helper, the failure is reported to the caller.
      await expect(prisma.inTransaction(writeUnbalanced)).rejects.toThrow(/unbalanced/);

      // Through a plain Prisma transaction the database still rolls back at COMMIT.
      // (Prisma 5 resolves this promise anyway, which is why inTransaction exists.)
      await prisma.$transaction(writeUnbalanced).catch(() => undefined);
      expect(await prisma.posting.count()).toBe(0);
    });

    it('rejects a ledger.post call that does not balance, before touching the database', async () => {
      await wallet('alice');
      const accounts = await prisma.account.findMany({ where: { code: { startsWith: 'wallet:alice' } } });
      await expect(
        prisma.inTransaction((tx) =>
          ledger.post(tx, {
            type: 'TRANSFER',
            lines: [
              { accountId: accounts[0].id, amount: 100n },
              { accountId: accounts[1].id, amount: -99n },
            ],
          }),
        ),
      ).rejects.toThrow(/does not balance/);
    });

    it('rejects a negative balance on a user account, even from raw SQL', async () => {
      await wallet('alice');
      await expect(
        prisma.$executeRawUnsafe("UPDATE accounts SET balance = -1 WHERE code = 'wallet:alice:available'"),
      ).rejects.toThrow(/accounts_balance_non_negative/);
    });
  });
});
