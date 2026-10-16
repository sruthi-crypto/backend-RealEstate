-- Runtime integration configuration.
-- Store activation state and public identifiers here; never store API keys or bot tokens.

CREATE TABLE IF NOT EXISTS payment_gateways (
  key             VARCHAR(32) PRIMARY KEY,
  provider_key    VARCHAR(32) NOT NULL DEFAULT 'cashfree',
  account_label   VARCHAR(64) NOT NULL DEFAULT 'Default account',
  display_name    VARCHAR(64) NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  adapter_status  VARCHAR(20) NOT NULL DEFAULT 'planned'
                  CHECK (adapter_status IN ('ready', 'planned')),
  environment     VARCHAR(20) NOT NULL DEFAULT 'production'
                  CHECK (environment IN ('sandbox', 'production')),
  required_secrets JSONB NOT NULL DEFAULT '[]'::jsonb,
  encrypted_secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_bots (
  key             VARCHAR(32) PRIMARY KEY,
  bot_id          VARCHAR(64),
  display_name    VARCHAR(64) NOT NULL,
  username        VARCHAR(128) NOT NULL,
  webhook_path    VARCHAR(128) NOT NULL,
  purpose         VARCHAR(64) NOT NULL,
  required_secrets JSONB NOT NULL DEFAULT '[]'::jsonb,
  encrypted_secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_settings (
  id                    SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_payment_key    VARCHAR(32) NOT NULL REFERENCES payment_gateways(key),
  active_telegram_key   VARCHAR(32) NOT NULL REFERENCES telegram_bots(key),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payment_gateways ADD COLUMN IF NOT EXISTS required_secrets JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE payment_gateways ADD COLUMN IF NOT EXISTS provider_key VARCHAR(32) NOT NULL DEFAULT 'cashfree';
ALTER TABLE payment_gateways ADD COLUMN IF NOT EXISTS account_label VARCHAR(64) NOT NULL DEFAULT 'Default account';
ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS required_secrets JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS bot_id VARCHAR(64);
ALTER TABLE payment_gateways ADD COLUMN IF NOT EXISTS encrypted_secrets JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS encrypted_secrets JSONB NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO payment_gateways (key, display_name, enabled, adapter_status, environment)
VALUES
  ('cashfree', 'Cashfree', true, 'ready', 'production'),
  ('razorpay', 'Razorpay', false, 'planned', 'production'),
  ('payu', 'PayU', false, 'planned', 'production')
ON CONFLICT (key) DO NOTHING;

UPDATE payment_gateways
SET required_secrets = '["CASHFREE_CLIENT_ID", "CASHFREE_CLIENT_SECRET", "CASHFREE_WEBHOOK_SECRET"]'::jsonb
WHERE key = 'cashfree';

UPDATE payment_gateways SET provider_key = 'cashfree', account_label = 'Cashfree Account 1' WHERE key = 'cashfree';
UPDATE payment_gateways SET provider_key = 'razorpay' WHERE key = 'razorpay';
UPDATE payment_gateways SET provider_key = 'payu' WHERE key = 'payu';

INSERT INTO telegram_bots (key, display_name, username, webhook_path, purpose, enabled)
VALUES
  ('cashfree_bot', 'Cashfree Ticket Bot', 'supremv_bot', '/cf-bot/webhook', 'Cashfree ticket booking', true)
ON CONFLICT (key) DO NOTHING;

UPDATE telegram_bots
SET required_secrets = '["CF_BOT_TOKEN"]'::jsonb
WHERE key = 'cashfree_bot';

INSERT INTO flow_settings (id, active_payment_key, active_telegram_key)
VALUES (1, 'cashfree', 'cashfree_bot')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE payment_gateways DISABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_bots DISABLE ROW LEVEL SECURITY;
ALTER TABLE flow_settings DISABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION update_integration_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_gateways_updated_at ON payment_gateways;
CREATE TRIGGER payment_gateways_updated_at
  BEFORE UPDATE ON payment_gateways FOR EACH ROW EXECUTE FUNCTION update_integration_updated_at();
DROP TRIGGER IF EXISTS telegram_bots_updated_at ON telegram_bots;
CREATE TRIGGER telegram_bots_updated_at
  BEFORE UPDATE ON telegram_bots FOR EACH ROW EXECUTE FUNCTION update_integration_updated_at();
DROP TRIGGER IF EXISTS flow_settings_updated_at ON flow_settings;
CREATE TRIGGER flow_settings_updated_at
  BEFORE UPDATE ON flow_settings FOR EACH ROW EXECUTE FUNCTION update_integration_updated_at();
