-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('AVAILABLE', 'HELD', 'SYSTEM');

-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'HOLD', 'CAPTURE', 'RELEASE');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('OPEN', 'CAPTURED', 'RELEASED');

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "wallet_id" UUID,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "type" "EntryType" NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "postings" (
    "id" BIGSERIAL NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holds" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'OPEN',
    "hold_entry_id" UUID NOT NULL,
    "settle_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_owner_id_key" ON "wallets"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_wallet_id_kind_key" ON "accounts"("wallet_id", "kind");

-- CreateIndex
CREATE INDEX "postings_account_id_id_idx" ON "postings"("account_id", "id");

-- CreateIndex
CREATE INDEX "postings_entry_id_idx" ON "postings"("entry_id");

-- CreateIndex
CREATE INDEX "holds_wallet_id_status_idx" ON "holds"("wallet_id", "status");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holds" ADD CONSTRAINT "holds_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Ledger guarantees enforced by the database, not only by application code.
-- ---------------------------------------------------------------------------

-- 1. No negative balances, unless the account is explicitly allowed (system accounts).
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_balance_non_negative" CHECK ("allow_negative" OR "balance" >= 0);

-- 2. Postings are never zero, and amounts and holds are always positive.
ALTER TABLE "postings" ADD CONSTRAINT "postings_amount_non_zero" CHECK ("amount" <> 0);
ALTER TABLE "holds" ADD CONSTRAINT "holds_amount_positive" CHECK ("amount" > 0);

-- 3. Journal entries and postings are immutable.
CREATE FUNCTION ledger_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE ON "postings"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();

-- 4. Every journal entry balances: its postings sum to zero and there are at least two.
--    Deferred, so it runs at COMMIT after all postings of the entry are inserted.
CREATE FUNCTION ledger_check_entry_balanced() RETURNS trigger AS $$
DECLARE
  total numeric;
  lines int;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO total, lines
    FROM "postings" WHERE entry_id = NEW.entry_id;
  IF total <> 0 OR lines < 2 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (sum %, % postings)', NEW.entry_id, total, lines
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER postings_entry_balanced AFTER INSERT ON "postings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_balanced();
