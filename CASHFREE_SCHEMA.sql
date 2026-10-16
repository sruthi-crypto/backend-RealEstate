-- ============================================================
-- Cashfree Ticket Booking Schema
-- Additive only — does NOT modify existing Stars payment tables
-- Run in Supabase SQL Editor
-- ============================================================

-- ticket_orders: one row per booking attempt from Telegram
CREATE TABLE IF NOT EXISTS ticket_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_order_id VARCHAR(32) UNIQUE NOT NULL,   -- e.g. SG-20260911-000001
  telegram_user_id  BIGINT NOT NULL,
  telegram_chat_id  BIGINT NOT NULL,
  telegram_username VARCHAR(128),
  website_user_id   UUID REFERENCES users(id),
  customer_phone    VARCHAR(32),                 -- logged-in website user's phone at booking time
  ticket_type       VARCHAR(32) NOT NULL CHECK (ticket_type IN ('free','normal','vip','premium')),
  amount_paise      INT NOT NULL,                  -- amount in paise (₹5000 = 500000)
  currency          VARCHAR(8) DEFAULT 'INR',
  status            VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending','awaiting_payment','paid','failed','cancelled')),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- payment_attempts: one row per Cashfree order creation attempt
CREATE TABLE IF NOT EXISTS payment_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_order_id     UUID NOT NULL REFERENCES ticket_orders(id),
  attempt_number      INT NOT NULL DEFAULT 1,
  provider            VARCHAR(32) NOT NULL DEFAULT 'cashfree',
  cf_order_id         VARCHAR(128) UNIQUE,         -- Cashfree order_id
  cf_payment_session  VARCHAR(512),                -- payment_session_id from Cashfree
  cf_payment_id       VARCHAR(128),                -- Cashfree payment_id (set on success)
  payment_link        TEXT,                        -- checkout URL sent to user
  amount_paise        INT NOT NULL,
  status              VARCHAR(20) DEFAULT 'created'
                      CHECK (status IN ('created','pending','success','failed','cancelled','unknown')),
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- cf_webhook_events: raw webhook log for audit + idempotency
CREATE TABLE IF NOT EXISTS cf_webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cf_order_id     VARCHAR(128) NOT NULL,
  cf_payment_id   VARCHAR(128),
  event_type      VARCHAR(64),
  payload         JSONB,
  signature_valid BOOLEAN DEFAULT false,
  processed       BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- issued_tickets: one row per successfully paid order (idempotent)
CREATE TABLE IF NOT EXISTS issued_tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number     VARCHAR(32) UNIQUE NOT NULL,   -- e.g. SG-2026-00000001
  ticket_order_id   UUID UNIQUE NOT NULL REFERENCES ticket_orders(id),
  payment_attempt_id UUID NOT NULL REFERENCES payment_attempts(id),
  telegram_user_id  BIGINT NOT NULL,
  telegram_chat_id  BIGINT NOT NULL,
  website_user_id   UUID REFERENCES users(id),
  customer_phone    VARCHAR(32),                 -- immutable phone snapshot shown on the ticket
  ticket_type       VARCHAR(32) NOT NULL,
  amount_paise      INT NOT NULL,
  provider          VARCHAR(32) NOT NULL DEFAULT 'cashfree',
  cf_payment_id     VARCHAR(128),
  status            VARCHAR(20) DEFAULT 'active',
  issued_at         TIMESTAMPTZ DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Existing installation migration (safe to run repeatedly)
-- These fields link a Telegram purchase to the website account.
-- Run this after creating the tables so both new and old installations work.
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(128);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;

ALTER TABLE ticket_orders  ADD COLUMN IF NOT EXISTS website_user_id UUID REFERENCES users(id);
ALTER TABLE ticket_orders  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(32);
ALTER TABLE issued_tickets ADD COLUMN IF NOT EXISTS website_user_id UUID REFERENCES users(id);
ALTER TABLE issued_tickets ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(32);

-- Existing databases have the old ticket-type constraint. Replace it so the
-- immediate, zero-cost Free ticket is accepted too.
ALTER TABLE ticket_orders DROP CONSTRAINT IF EXISTS ticket_orders_ticket_type_check;
ALTER TABLE ticket_orders ADD CONSTRAINT ticket_orders_ticket_type_check
  CHECK (ticket_type IN ('free','normal','vip','premium'));

-- Disable RLS (Worker uses service_role key)
ALTER TABLE ticket_orders      DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts   DISABLE ROW LEVEL SECURITY;
ALTER TABLE cf_webhook_events  DISABLE ROW LEVEL SECURITY;
ALTER TABLE issued_tickets     DISABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ticket_orders_tg_user   ON ticket_orders(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_status    ON ticket_orders(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_order  ON payment_attempts(ticket_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_cf_id  ON payment_attempts(cf_order_id);
CREATE INDEX IF NOT EXISTS idx_cf_webhook_cf_order     ON cf_webhook_events(cf_order_id);
CREATE INDEX IF NOT EXISTS idx_issued_tickets_tg_user  ON issued_tickets(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_issued_tickets_website_user ON issued_tickets(website_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_website_user  ON ticket_orders(website_user_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_orders_updated_at ON ticket_orders;
CREATE TRIGGER ticket_orders_updated_at
  BEFORE UPDATE ON ticket_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS payment_attempts_updated_at ON payment_attempts;
CREATE TRIGGER payment_attempts_updated_at
  BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
