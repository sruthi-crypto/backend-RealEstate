# Payment and Telegram Admin Configuration

## What was added

The admin page is available at:

```text
/admin/integrations
```

It contains:

- Payment gateway rows: Cashfree, Razorpay, and PayU.
- Telegram bot rows.
- Enabled/disabled state.
- Adapter readiness.
- Credential readiness without revealing secrets.
- Runtime activation controls.

The current live adapter is Cashfree. Razorpay and PayU are listed as planned until their backend adapters are implemented.

## Important security rule

Do not store these values in the admin page or in a normal database table:

- Cashfree client secret.
- Cashfree webhook secret.
- Razorpay secret key.
- PayU salt.
- Telegram bot token.

These are server secrets. Store them in Cloudflare Worker secret bindings:

```powershell
npx wrangler secret put CF_BOT_TOKEN
npx wrangler secret put CASHFREE_CLIENT_ID
npx wrangler secret put CASHFREE_CLIENT_SECRET
npx wrangler secret put CASHFREE_WEBHOOK_SECRET
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

When Razorpay or PayU adapters are implemented, add their secrets in the same way. The admin page only changes runtime activation state and never returns secret values to the browser.

## One-time database migration

Run this file in Supabase SQL Editor:

```text
INTEGRATION_CONFIG_SCHEMA.sql
```

It creates:

```text
payment_gateways
telegram_bots
flow_settings
```

The migration seeds:

```text
Cashfree       enabled, adapter ready
Razorpay       disabled, adapter planned
PayU           disabled, adapter planned
supremv_bot    enabled as the Cashfree ticket bot
```

## Runtime activation

When an admin activates a ready gateway or bot:

1. The backend updates Supabase runtime settings.
2. New user flows read the new active setting.
3. The old Worker process remains available.
4. No Vite rebuild is required.
5. No Cloudflare Worker redeploy is required.
6. No website downtime occurs.

The current backend endpoint is:

```text
GET   /api/integrations
PATCH /api/integrations
```

Both endpoints require an admin JWT.

Example gateway update:

```json
{
  "gateway_key": "cashfree",
  "enabled": true
}
```

Example Telegram bot update:

```json
{
  "bot_key": "cashfree_bot",
  "enabled": true
}
```

## Why redeployment is not used for toggles

A deployment is appropriate for code and secret changes. An activation toggle is application data, so it belongs in Supabase. Rebuilding the frontend or deploying a new Worker for every admin click would be slower, riskier, and unnecessary.

For zero-downtime operation:

- Keep secrets in Cloudflare bindings.
- Keep activation state in Supabase.
- Let each request read the active runtime flow.
- Deploy only when code or secret bindings change.

## Current limitation

The UI intentionally rejects activation of Razorpay and PayU because their adapters are not implemented yet. A provider is not complete merely because its row exists. Each provider needs:

```text
create order
checkout/redirect handling
webhook signature verification
payment status lookup
amount verification
idempotent payment mapping
```

After those adapters are implemented, change the provider row from `planned` to `ready` and configure its Cloudflare secrets. It can then be activated from the same admin screen.

## Deployment after code or schema changes

Deploy the backend after adding the schema/API code:

```powershell
cd "C:\Users\LANKIREDDY SUSHRUTHA\Desktop\realestate\backend for test this telegram\backend-RealEstate"
npx wrangler deploy
```

Build the frontend:

```powershell
cd "C:\Users\LANKIREDDY SUSHRUTHA\Desktop\realestate\backend for test this telegram\realestate-supreme-ventures"
npm run build
```

After deployment, open the website as an admin and visit:

```text
/admin/integrations
```

## Operational checks

Before activating a provider:

- [ ] Its adapter says `Ready`.
- [ ] Its server secrets are configured.
- [ ] Its webhook URL is configured with the provider.
- [ ] Its environment is correct: sandbox or production.
- [ ] A test payment completes.
- [ ] A ticket is generated exactly once.
- [ ] Telegram receives the ticket.
- [ ] The website receives the ticket.
- [ ] Admin ticket history shows the ticket.

Before disabling the active bot or provider:

- [ ] A replacement integration is ready.
- [ ] The replacement is activated first.
- [ ] Existing orders remain tied to their original provider.
- [ ] Pending orders have a recovery plan.
