-- ============================================================
-- TASK 1 FIX: users table — disable RLS or add insert policy
-- so the anon/service key can insert normal users
-- ============================================================

-- Option A (simplest for Cloudflare Worker using service_role key):
-- Make sure SUPABASE_KEY is the service_role key, not the anon key.
-- The service_role key bypasses RLS entirely.

-- Option B: If you must use anon key, add this policy:
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "allow_insert_user" ON users FOR INSERT WITH CHECK (role = 'user');
-- CREATE POLICY "allow_select_by_phone" ON users FOR SELECT USING (true);

-- Safest for a Worker backend: use service_role key and disable RLS on users:
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

-- Ensure role column allows 'user' value (add if missing):
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
-- ALTER TABLE users ADD CONSTRAINT users_role_check
--   CHECK (role IN ('user','admin','super_admin'));

-- ============================================================
-- TASK 2: New tables for Telegram Stars payment system
-- ============================================================

-- packages (plans users can buy)
CREATE TABLE IF NOT EXISTS packages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255) UNIQUE NOT NULL,
  description      TEXT,
  stars            INT NOT NULL CHECK (stars > 0),
  total_seats      INT NOT NULL CHECK (total_seats > 0),
  available_seats  INT NOT NULL CHECK (available_seats >= 0),
  is_active        BOOLEAN DEFAULT true,
  sort_order       INT DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- seats (one row per slot inside a package)
CREATE TABLE IF NOT EXISTS seats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id  UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  seat_number INT NOT NULL,
  status      VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available','reserved','booked')),
  order_id    UUID,
  booked_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (package_id, seat_number)
);

-- orders (one per purchase attempt)
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        VARCHAR(32) UNIQUE NOT NULL,
  user_id         UUID NOT NULL REFERENCES users(id),
  package_id      UUID NOT NULL REFERENCES packages(id),
  stars           INT NOT NULL,
  status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
  invoice_payload VARCHAR(256) UNIQUE,
  telegram_id     BIGINT,
  ticket_id       UUID,
  seat_number     INT,
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- payments (idempotent ledger)
CREATE TABLE IF NOT EXISTS payments (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                      UUID NOT NULL REFERENCES orders(id),
  telegram_id                   BIGINT,
  invoice_payload               VARCHAR(256),
  telegram_payment_charge_id    VARCHAR(256) UNIQUE NOT NULL,
  provider_payment_charge_id    VARCHAR(256),
  stars                         INT NOT NULL,
  currency                      VARCHAR(8) DEFAULT 'XTR',
  paid_at                       TIMESTAMPTZ DEFAULT now(),
  created_at                    TIMESTAMPTZ DEFAULT now(),
  updated_at                    TIMESTAMPTZ DEFAULT now()
);

-- tickets (proof of purchase)
CREATE TABLE IF NOT EXISTS tickets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number  VARCHAR(32) UNIQUE NOT NULL,
  order_id       UUID UNIQUE NOT NULL REFERENCES orders(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  package_id     UUID NOT NULL REFERENCES packages(id),
  stars          INT NOT NULL,
  issued_at      TIMESTAMPTZ DEFAULT now(),
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- booking_logs (audit trail)
CREATE TABLE IF NOT EXISTS booking_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID REFERENCES orders(id),
  telegram_id BIGINT,
  event       VARCHAR(100) NOT NULL,
  success     BOOLEAN DEFAULT true,
  detail      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Disable RLS on all new tables (Worker uses service_role key)
ALTER TABLE packages     DISABLE ROW LEVEL SECURITY;
ALTER TABLE seats        DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders       DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments     DISABLE ROW LEVEL SECURITY;
ALTER TABLE tickets      DISABLE ROW LEVEL SECURITY;
ALTER TABLE booking_logs DISABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_seats_package_status   ON seats(package_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_user            ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_payload         ON orders(invoice_payload);
CREATE INDEX IF NOT EXISTS idx_payments_charge        ON payments(telegram_payment_charge_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user           ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_booking_logs_order     ON booking_logs(order_id);

-- Auto-update updated_at trigger (reuse or create)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER packages_updated_at     BEFORE UPDATE ON packages     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER seats_updated_at        BEFORE UPDATE ON seats        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER orders_updated_at       BEFORE UPDATE ON orders       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER payments_updated_at     BEFORE UPDATE ON payments     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tickets_updated_at      BEFORE UPDATE ON tickets      FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- SEED: 4 default packages + their seats
-- ============================================================
DO $$
DECLARE
  pkg_id UUID;
  i INT;
  plans JSONB := '[
    {"name":"Starter",      "description":"Basic access — entry-level property listings",      "stars":20,"seats":100,"sort":1},
    {"name":"Standard",     "description":"Standard access — premium property listings",        "stars":40,"seats":100,"sort":2},
    {"name":"Professional", "description":"Pro access — exclusive listings + analytics",        "stars":60,"seats":50, "sort":3},
    {"name":"Ultimate",     "description":"Unlimited access — all listings + priority support", "stars":80,"seats":25, "sort":4}
  ]'::JSONB;
  plan JSONB;
BEGIN
  FOR plan IN SELECT * FROM jsonb_array_elements(plans) LOOP
    INSERT INTO packages (name, description, stars, total_seats, available_seats, sort_order)
    VALUES (
      plan->>'name', plan->>'description',
      (plan->>'stars')::INT, (plan->>'seats')::INT, (plan->>'seats')::INT,
      (plan->>'sort')::INT
    )
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO pkg_id;

    IF pkg_id IS NOT NULL THEN
      FOR i IN 1..(plan->>'seats')::INT LOOP
        INSERT INTO seats (package_id, seat_number) VALUES (pkg_id, i)
        ON CONFLICT (package_id, seat_number) DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;
END $$;
