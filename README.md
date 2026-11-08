# Ledger Service

A small double-entry wallet ledger in **NestJS, Prisma and PostgreSQL**. It supports
deposits, withdrawals, transfers and **holds** (fund reservations, like an open order),
and is built so that money stays correct under retries and concurrent requests.

I built it to practise the parts of a trading or payments backend where a bug is a
money bug: immutable journal entries, balances that never go negative, idempotent
endpoints, and row locking under concurrency. Every guarantee below has a test that
runs against a real PostgreSQL database.

## Guarantees

| Guarantee | How | Enforced by |
|---|---|---|
| Every journal entry balances (postings sum to 0) | Checked before writing, and by a deferred constraint trigger at commit | App + database |
| Journal entries and postings are immutable | `BEFORE UPDATE OR DELETE` trigger raises an error | Database |
| User balances never go negative | Checked under row lock, plus `CHECK (allow_negative OR balance >= 0)` | App + database |
| No floating-point money | Amounts are `BIGINT` cents; the API accepts and returns decimal strings only (`"12.34"`) | App |
| Retries never move money twice | Required `Idempotency-Key`, claimed in the same transaction as the movement | App + unique key |
| No lost updates or deadlocks | `SELECT … FOR UPDATE` on every touched account, always in id order | Database locks |
| Cached balances never drift | `GET /ledger/invariants` proves `balance = SUM(postings)` for every account | Check endpoint, run after every test |

## Design

**Double entry.** Each wallet has two accounts: `AVAILABLE` and `HELD`. Two system
accounts (`system:deposits`, `system:withdrawals`) stand for the outside world and
are the only accounts allowed to go negative. Every movement is one journal entry
with signed postings that sum to zero:

| Operation | Postings |
|---|---|
| Deposit | `system:deposits −X`, `wallet:available +X` |
| Withdrawal | `wallet:available −X`, `system:withdrawals +X` |
| Transfer | `from:available −X`, `to:available +X` |
| Hold | `wallet:available −X`, `wallet:held +X` |
| Capture hold | `payer:held −X`, `payee:available +X` |
| Release hold | `wallet:held −X`, `wallet:available +X` |

Reserving funds is itself a ledger entry, so held money is always visible in the
ledger. A hold row is locked when it is captured or released, so it settles exactly
once even if capture and release race.

**Balances.** `accounts.balance` is a cache of `SUM(postings.amount)`, updated in the
same transaction as the postings, so reads are O(1). The invariant check proves the
cache matches the journal.

**Concurrency.** Transactions run at `READ COMMITTED`. `LedgerService.post()` locks
all touched accounts with `SELECT … FOR UPDATE ORDER BY id` before checking balances.
A fixed lock order means two entries over the same accounts cannot deadlock (the test
suite runs transfers in opposite directions at the same time to prove it).

**Idempotency.** A money request claims its key with
`INSERT … ON CONFLICT DO NOTHING` inside the same transaction as the movement. A
concurrent request with the same key blocks on that row until the first commits
(then it gets the stored response, marked `Idempotent-Replayed: true`) or rolls back
(then it runs). Reusing a key for a different request returns `409`. Failed requests
are not stored, so a client can retry them with the same key.

### A Prisma pitfall this project found

Prisma 5 does not report errors that PostgreSQL raises **during `COMMIT`**. When the
deferred "entry must balance" trigger rejected a transaction, PostgreSQL rolled it
back, but `prisma.$transaction()` still resolved. An API built that way would answer
`201 Created` for money that never moved.

`PrismaService.inTransaction()` runs `SET CONSTRAINTS ALL IMMEDIATE` as the last step
of every transaction, so deferred checks run before `COMMIT` and fail as a normal,
catchable error. A test covers both paths.

## API

Interactive docs (Swagger) are served at `/docs`.

| Method | Path | Idempotency-Key |
|---|---|---|
| `POST` | `/wallets` | |
| `GET` | `/wallets/:ownerId` | |
| `GET` | `/wallets/:ownerId/entries` | |
| `POST` | `/wallets/:ownerId/deposits` | required |
| `POST` | `/wallets/:ownerId/withdrawals` | required |
| `POST` | `/transfers` | required |
| `POST` | `/wallets/:ownerId/holds` | required |
| `POST` | `/holds/:holdId/capture` | required |
| `POST` | `/holds/:holdId/release` | required |
| `GET` | `/ledger/invariants` | |

Errors have a stable shape: `{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "…" } }`.

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{"ownerId":"alice"}'
curl -X POST localhost:3000/wallets/alice/deposits \
  -H 'content-type: application/json' -H 'Idempotency-Key: dep-0001-alice' \
  -d '{"amount":"100.00"}'
```

## Running it

Requires Node.js 20 and PostgreSQL 15 or later.

```bash
npm install
docker compose up -d              # or use a local PostgreSQL
cp .env.example .env              # dev database
cp .env.test.example .env.test    # test database (tests truncate it)
npx prisma migrate deploy
npm run db:migrate:test
npm test
npm run dev                       # http://localhost:3000/docs
```

## Tests

`npm test` runs 43 tests: unit tests for money parsing and end-to-end tests over HTTP
against a real PostgreSQL database. After every test, the suite asserts that all
postings sum to zero, no cached balance has drifted and no user balance is negative.

- 50 concurrent withdrawals of 10.00 from a 100.00 balance: exactly 10 succeed, 40 get `422`, balance ends at 0.00
- 40 concurrent transfers in opposite directions between two wallets: no deadlocks, balances unchanged
- 80 random concurrent transfers, withdrawals and holds across 4 wallets: the ledger stays consistent
- 10 concurrent requests with the same `Idempotency-Key`: one journal entry
- 5 captures and 5 releases of the same hold at once: exactly one succeeds
- Direct SQL that updates or deletes postings, writes an unbalanced entry, or sets a negative balance is rejected by the database

## Out of scope

This is a focused practice project, not a production system. Next steps I would take:

- An order-matching engine on top of holds (place order = hold, fill = capture, cancel = release)
- A transactional outbox to publish ledger events to Kafka / Redpanda
- Load testing with k6 to measure p99 latency and throughput per account shard
- Authentication, multi-currency support and daily reconciliation against external balances
