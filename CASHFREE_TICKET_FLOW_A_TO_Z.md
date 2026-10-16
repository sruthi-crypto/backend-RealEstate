# Cashfree Telegram Ticket Flow: A to Z

This document describes the complete ticket-booking system:

1. User logs in on the website.
2. User clicks the Telegram button.
3. Telegram opens `@supremv_bot`.
4. The bot shows the ticket list.
5. User selects Free, Normal, VIP, or Premium.
6. Paid tickets open Cashfree checkout.
7. Cashfree confirms payment through webhook or recovery verification.
8. The backend automatically generates one ticket.
9. The ticket is sent to Telegram.
10. The same ticket appears on the website.
11. Admin can view issued tickets, but never creates tickets manually.

The payment provider is Cashfree. Telegram is only used for ticket selection, payment navigation, and ticket delivery.

## 1. Final User Experience

### Website

The user:

1. Opens the website.
2. Registers or logs in with the website account.
3. Opens the ticket/packages page.
4. Clicks the Telegram icon or the Cashfree booking button.
5. The website opens a URL similar to:

```text
https://t.me/supremv_bot?start=<WEBSITE_USER_ID>
```

The website user ID is included so the backend can connect the Telegram user to the website account.

### Telegram

The bot receives `/start <WEBSITE_USER_ID>` and shows:

```text
Select Your Ticket

[Free       ₹0]
[Normal     ₹1]
[VIP        ₹2]
[Premium    ₹3]
```

The actual bot username is:

```text
@supremv_bot
```

`Suprem12_bot` is the bot display name, not the username.

### Free ticket

For a Free ticket:

1. User clicks `Free`.
2. Backend creates a `ticket_orders` row.
3. Backend immediately creates an `issued_tickets` row.
4. The order status becomes `paid`.
5. Telegram receives the ticket message.
6. The website shows the same ticket after polling `/api/user-auth/cf-tickets`.

No Cashfree payment is required for the Free ticket.

### Paid ticket

For Normal, VIP, or Premium:

1. User clicks a paid ticket button.
2. Backend creates a `ticket_orders` row with status `awaiting_payment`.
3. Backend creates a Cashfree order.
4. Backend saves a `payment_attempts` row.
5. Telegram receives a Cashfree payment button.
6. User completes UPI, card, or net-banking payment.
7. Cashfree redirects the browser to the payment return page.
8. Cashfree also sends a payment webhook to the backend.
9. Backend verifies the payment directly with Cashfree.
10. Backend generates the ticket once.
11. Telegram receives the successful-payment ticket message.
12. Website polling finds the same ticket.

## 2. System Architecture

```text
Website
  |
  | User logs in and clicks Telegram button
  v
Telegram @supremv_bot
  |
  | /start <website_user_id>
  v
Cloudflare Worker: POST /cf-bot/webhook
  |
  | User selects ticket
  v
Supabase: ticket_orders
  |
  | Paid ticket only
  v
Cashfree order creation
  |
  v
Telegram payment button
  |
  v
Cashfree Checkout
  |                         \
  | browser return            \ payment webhook
  v                            v
Worker /cf-payment/return       Worker /cashfree/webhook
  |                            |
  | recovery verification      | direct verification
  v                            v
        issue ticket exactly once
                    |
        +-----------+-----------+
        |                           |
        v                           v
Telegram ticket message       Website ticket polling
```

## 3. Components

### Frontend

Important files:

```text
realestate-supreme-ventures/src/pages/Packages.tsx
realestate-supreme-ventures/src/components/TelegramButton.tsx
realestate-supreme-ventures/src/pages/AdminTickets.tsx
```

Responsibilities:

- Keep website login state.
- Build the Telegram deep link.
- Pass the website user ID to the bot.
- Poll the authenticated user's tickets.
- Display ticket number, type, amount, phone, date, and status.
- Show admin ticket records through the admin page.

The frontend does not create tickets and does not decide whether payment succeeded.

### Backend

Important files:

```text
backend-RealEstate/src/index.ts
backend-RealEstate/src/cashfree.ts
backend-RealEstate/CASHFREE_SCHEMA.sql
backend-RealEstate/wrangler.jsonc
```

Responsibilities:

- Receive Telegram updates.
- Link Telegram accounts to website accounts.
- Create ticket orders.
- Create Cashfree orders.
- Verify Cashfree webhooks.
- Verify payment status directly with Cashfree.
- Generate tickets idempotently.
- Send tickets to Telegram.
- Return tickets to the website API.

### Database

Supabase stores:

- `ticket_orders`: one booking attempt.
- `payment_attempts`: one Cashfree order/payment attempt.
- `cf_webhook_events`: raw webhook audit records.
- `issued_tickets`: final tickets delivered to users.
- `users.telegram_id`: connection between website and Telegram.
- `users.telegram_username`: Telegram username snapshot.

## 4. Required Environment Variables

### Frontend `.env`

```env
VITE_API_BASE_URL=https://apis-realestate.sushruthalanki1.workers.dev/api/
VITE_CF_BOT_USERNAME=supremv_bot
```

Do not use `suprem12_bot` as the username. That is only the display name visible in Telegram.

After changing `.env`, restart Vite because Vite loads environment variables when the dev server starts:

```powershell
npm run dev
```

### Cloudflare Worker variables

```jsonc
{
  "vars": {
    "CF_BOT_USERNAME": "supremv_bot",
    "CASHFREE_ENVIRONMENT": "production",
    "API_BASE_URL": "https://apis-realestate.sushruthalanki1.workers.dev"
  }
}
```

### Cloudflare Worker secrets

Set secrets with Wrangler. Never commit real secrets to Git:

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put JWT_SECRET
npx wrangler secret put CF_BOT_TOKEN
npx wrangler secret put CASHFREE_CLIENT_ID
npx wrangler secret put CASHFREE_CLIENT_SECRET
npx wrangler secret put CASHFREE_WEBHOOK_SECRET
```

Optional notification variables can be used for unrelated legacy notifications, but they are not needed for the Cashfree ticket bot:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

## 5. Database Schema

Run the complete schema file in Supabase SQL Editor:

```text
CASHFREE_SCHEMA.sql
```

### `ticket_orders`

Represents the user's selected ticket:

```sql
id
internal_order_id
telegram_user_id
telegram_chat_id
telegram_username
website_user_id
customer_phone
ticket_type             -- free, normal, vip, premium
amount_paise
currency                -- INR
status                  -- pending, awaiting_payment, paid, failed, cancelled
created_at
updated_at
```

### `payment_attempts`

Represents a Cashfree order attempt:

```sql
id
ticket_order_id
attempt_number
provider                -- cashfree
cf_order_id             -- provider-generated Cashfree ID
cf_payment_session      -- Cashfree checkout session
cf_payment_id           -- filled after success
payment_link
amount_paise
status                  -- created, pending, success, failed, cancelled, unknown
failure_reason
created_at
updated_at
```

### `issued_tickets`

Represents the final ticket. `ticket_order_id` must be unique so a retry cannot create duplicate tickets:

```sql
id
ticket_number
 ticket_order_id         -- unique
payment_attempt_id
telegram_user_id
telegram_chat_id
website_user_id
customer_phone
ticket_type
amount_paise
provider                 -- free or cashfree
cf_payment_id
status                   -- active
issued_at
created_at
```

The real SQL schema is authoritative. The spaced `ticket_order_id` above is only formatting; the actual column name is `ticket_order_id`.

## 6. Telegram Webhook

The Worker accepts the Cashfree bot webhook at:

```text
POST https://apis-realestate.sushruthalanki1.workers.dev/cf-bot/webhook
```

For compatibility with an older Telegram configuration, the Worker also accepts:

```text
POST https://apis-realestate.sushruthalanki1.workers.dev/bot/webhook
```

Register the Cashfree bot webhook with Bot API:

```powershell
curl.exe -X POST "https://api.telegram.org/bot<CF_BOT_TOKEN>/setWebhook" `
  -d "url=https://apis-realestate.sushruthalanki1.workers.dev/cf-bot/webhook"
```

Check the webhook status:

```powershell
curl.exe "https://api.telegram.org/bot<CF_BOT_TOKEN>/getWebhookInfo"
```

The response should show the expected Worker URL and no persistent `last_error_message`.

If the bot receives no `/start` response, check the webhook first.

## 7. Website to Telegram Flow

The frontend should normalize the username before building the link:

```ts
const botUsername = ((import.meta.env.VITE_CF_BOT_USERNAME as string) || "supremv_bot")
  .trim()
  .replace(/^@+/, "");

const telegramUrl = `https://t.me/${botUsername}?start=${websiteUserId}`;
window.open(telegramUrl, "_blank");
```

The `@` character must not be included inside the URL path. Both of these are valid inputs after normalization:

```text
supremv_bot
@supremv_bot
```

The generated URL must be:

```text
https://t.me/supremv_bot?start=<WEBSITE_USER_ID>
```

## 8. Telegram `/start` Handling

The backend receives a Telegram update similar to:

```json
{
  "message": {
    "chat": { "id": 123456789 },
    "from": {
      "id": 123456789,
      "username": "customer_name"
    },
    "text": "/start 2a2f7d2e-website-user-id"
  }
}
```

The handler must:

1. Read `chat.id`.
2. Read `from.id`.
3. Read `from.username`.
4. Extract the start parameter.
5. Update the matching website user:

```json
{
  "telegram_id": 123456789,
  "telegram_username": "customer_name"
}
```

6. Send the ticket selection inline keyboard.

The selection callback data is:

```text
ticket:free
ticket:normal
ticket:vip
ticket:premium
```

## 9. Ticket Selection Logic

The backend must own prices and ticket types. Never trust a price sent by the frontend or Telegram client.

Example server-side configuration:

```ts
const TICKET_TYPES = {
  free: 0,
  normal: 100,
  vip: 200,
  premium: 300,
};
```

Amounts are stored in paise:

```text
Free:    0 paise
Normal:  100 paise     = ₹1
VIP:     200 paise     = ₹2
Premium: 300 paise     = ₹3
```

For every selection:

1. Validate the callback ticket type.
2. Resolve the price from server configuration.
3. Find the linked website user using `telegram_id`.
4. Create a `ticket_orders` row.
5. For Free, issue the ticket immediately.
6. For paid tickets, create the Cashfree order.

## 10. Free Ticket Generation

Free ticket generation is automatic:

```text
Telegram callback
  -> ticket_orders row
  -> issued_tickets row
  -> ticket_orders.status = paid
  -> Telegram confirmation
  -> website polling displays ticket
```

The ticket should include:

```text
Ticket number
Ticket type: FREE
Amount: ₹0
Customer phone, if linked
Issued date
```

## 11. Cashfree Order Creation

For a paid ticket, create a Cashfree order using:

```text
order_id       = internal_order_id
order_amount   = amount_paise / 100
order_currency = INR
customer_id    = tg_<telegram_user_id>
customer_name
customer_phone
return_url     = <API_BASE_URL>/cf-payment/return?order_id=<internal_order_id>
```

Cashfree returns:

```text
cf_order_id
payment_session_id
```

Store these values in `payment_attempts`.

Important ID rule:

- `internal_order_id` is your merchant order ID, for example `SG-20260922-000001`.
- `cf_order_id` is generated by Cashfree.
- The payment return/status request must use the merchant order ID that was sent to Cashfree.
- Payment attempts should be matched to the internal ticket order using `ticket_order_id`.
- Do not assume `cf_order_id` and `internal_order_id` are the same value.

## 12. Cashfree Checkout

The bot sends a button pointing to:

```text
GET <API_BASE_URL>/cf-payment/checkout?session_id=<PAYMENT_SESSION_ID>
```

The Worker returns a small HTML page that submits the payment session to Cashfree's hosted checkout endpoint.

Production checkout endpoint:

```text
https://api.cashfree.com/pg/view/sessions/checkout
```

Sandbox checkout endpoint:

```text
https://sandbox.cashfree.com/pg/view/sessions/checkout
```

## 13. Cashfree Payment Webhook

Configure Cashfree to send payment webhooks to:

```text
POST https://apis-realestate.sushruthalanki1.workers.dev/cashfree/webhook
```

The webhook handler must:

1. Read the raw request body.
2. Read `x-webhook-timestamp`.
3. Read `x-webhook-signature`.
4. Verify the HMAC signature.
5. Store the raw event in `cf_webhook_events`.
6. Ignore invalid signatures when a webhook secret is configured.
7. Process only `PAYMENT_SUCCESS_WEBHOOK`.
8. Read the merchant `order_id` from the webhook.
9. Find `ticket_orders.internal_order_id`.
10. Check whether an `issued_tickets` row already exists.
11. Find the payment attempt through `ticket_order_id`.
12. Verify the amount.
13. Query Cashfree directly for the live payment status.
14. Require status `SUCCESS`.
15. Mark the payment attempt as `success`.
16. Mark the ticket order as `paid`.
17. Insert one `issued_tickets` row.
18. Send the ticket to Telegram.
19. Mark the webhook event as processed.

The webhook must be idempotent. Cashfree may retry webhook delivery. The unique `issued_tickets.ticket_order_id` constraint and the existing-ticket lookup prevent duplicate tickets.

## 14. Payment Return and Recovery

Cashfree redirects the browser to:

```text
GET <API_BASE_URL>/cf-payment/return?order_id=<internal_order_id>
```

The return page:

1. Tells the user payment is being verified.
2. Offers a link back to `@supremv_bot`.
3. Includes `start=cf_return`.
4. Offers a link back to the website.

The bot handles `/start cf_return` and `/tickets` by:

1. Finding the latest order for the Telegram user.
2. If already paid, loading its ticket and sending it.
3. If awaiting payment, finding its payment attempt.
4. Querying Cashfree with the merchant internal order ID.
5. Checking that Cashfree status is `SUCCESS`.
6. Calling the same idempotent ticket-generation function.
7. Sending the generated ticket.
8. Showing the waiting message only when Cashfree still does not report success.

This recovery path handles cases where Cashfree payment succeeds before the webhook arrives.

## 15. Ticket Message Format

Example successful Telegram message:

```text
PAYMENT SUCCESSFUL

Your Ticket

Ticket: SG-2026-00000001
Type: VIP
Amount: ₹2

Your ticket is also available on the website.
```

The same ticket number must be used in:

- Telegram message.
- `issued_tickets.ticket_number`.
- Website ticket card.
- Admin ticket table.

## 16. Website Ticket Synchronization

Authenticated website requests:

```text
GET /api/user-auth/cf-tickets
Authorization: Bearer <WEBSITE_USER_JWT>
```

The backend should return tickets matching either:

1. `issued_tickets.website_user_id = authenticated_user_id`, or
2. `issued_tickets.telegram_user_id = users.telegram_id`.

Merge duplicate records by ticket ID and sort by `issued_at` descending.

Example response:

```json
{
  "success": true,
  "message": "CF tickets fetched",
  "data": [
    {
      "id": "ticket-uuid",
      "ticket_number": "SG-2026-00000001",
      "ticket_type": "vip",
      "customer_phone": "+919876543210",
      "amount_paise": 200,
      "provider": "cashfree",
      "status": "active",
      "issued_at": "2026-09-22T12:40:00Z"
    }
  ]
}
```

The website can poll every 10 seconds after login. It does not generate or approve tickets locally.

## 17. Admin View

Admin endpoint:

```text
GET /api/cf-tickets
Authorization: Bearer <ADMIN_JWT>
```

Admin can view:

- Ticket number.
- Ticket type.
- Amount.
- Customer phone.
- Provider.
- Issue date.
- Status.

Admin does not need to click a button to create a ticket. Ticket creation is automatic after Free selection or verified Cashfree payment.

Admin support actions are only for monitoring and troubleshooting:

- Refresh ticket list.
- Inspect Cashfree order records.
- Inspect webhook events.
- Inspect payment attempt status.
- Check whether Telegram delivery failed.

## 18. API Route Contract

### Public and user routes

```text
POST /api/user-auth/register
POST /api/user-auth/login
GET  /api/user-auth/me
GET  /api/user-auth/cf-tickets
```

### Telegram routes

```text
POST /cf-bot/webhook
POST /bot/webhook              # compatibility alias
```

### Cashfree routes

```text
POST /cashfree/webhook
GET  /cf-payment/checkout?session_id=...
GET  /cf-payment/return?order_id=...
```

### Admin routes

```text
GET /api/cf-tickets
GET /api/cf-orders
```

## 19. Deployment Checklist

### Supabase

- [ ] Run `CASHFREE_SCHEMA.sql`.
- [ ] Confirm `ticket_orders` exists.
- [ ] Confirm `payment_attempts` exists.
- [ ] Confirm `issued_tickets` exists.
- [ ] Confirm `users.telegram_id` exists.
- [ ] Confirm unique index on `issued_tickets.ticket_order_id` exists.
- [ ] Confirm Worker service-role access works.

### Telegram

- [ ] Confirm the bot username is `@supremv_bot`.
- [ ] Confirm `CF_BOT_TOKEN` belongs to `@supremv_bot`.
- [ ] Register webhook at `/cf-bot/webhook`.
- [ ] Run `getWebhookInfo`.
- [ ] Confirm Telegram reports no webhook error.

### Cashfree

- [ ] Configure the correct environment: `sandbox` or `production`.
- [ ] Set `CASHFREE_CLIENT_ID`.
- [ ] Set `CASHFREE_CLIENT_SECRET`.
- [ ] Set `CASHFREE_WEBHOOK_SECRET`.
- [ ] Configure `PAYMENT_SUCCESS_WEBHOOK` delivery.
- [ ] Set return URL base to the deployed Worker URL.
- [ ] Confirm payment amounts are in rupees for Cashfree and paise in the database.

### Cloudflare Worker

```powershell
cd "C:\Users\LANKIREDDY SUSHRUTHA\Desktop\realestate\backend for test this telegram\backend-RealEstate"
npm install
npx wrangler deploy
```

After deployment:

```powershell
curl.exe https://apis-realestate.sushruthalanki1.workers.dev/
```

Expected result is a successful API response.

### Frontend

```powershell
cd "C:\Users\LANKIREDDY SUSHRUTHA\Desktop\realestate\backend for test this telegram\realestate-supreme-ventures"
npm install
npm run build
npm run dev
```

## 20. End-to-End Test Plan

### Test 1: Website to Telegram

1. Log in to the website.
2. Click the Telegram icon.
3. Confirm the URL is:

```text
https://t.me/supremv_bot?start=<USER_ID>
```

4. Confirm Telegram opens `Suprem12_bot` with username `@supremv_bot`.
5. Confirm the ticket list appears.

### Test 2: Free ticket

1. Click `Free`.
2. Confirm Telegram sends `FREE TICKET CONFIRMED`.
3. Copy the ticket number.
4. Open the website ticket list.
5. Confirm the same ticket number appears.
6. Confirm the ticket type is `free`.
7. Confirm the amount is ₹0.
8. Confirm one `issued_tickets` row exists.

### Test 3: Paid Cashfree ticket

1. Click `Normal`, `VIP`, or `Premium`.
2. Confirm a `ticket_orders` row is created with `awaiting_payment`.
3. Confirm a `payment_attempts` row is created.
4. Confirm Telegram shows the Cashfree payment button.
5. Complete payment in Cashfree.
6. Confirm Cashfree returns to `/cf-payment/return`.
7. Confirm Cashfree sends `PAYMENT_SUCCESS_WEBHOOK`.
8. Confirm payment status is checked directly with Cashfree.
9. Confirm `payment_attempts.status = success`.
10. Confirm `ticket_orders.status = paid`.
11. Confirm exactly one `issued_tickets` row exists.
12. Confirm Telegram receives the ticket.
13. Confirm the website displays the same ticket.

### Test 4: Delayed webhook recovery

1. Complete a paid payment.
2. Temporarily delay or retry the webhook.
3. Open Telegram.
4. Send `/tickets`.
5. Confirm the backend checks Cashfree directly.
6. Confirm the ticket is generated once.
7. Confirm no duplicate ticket is created when `/tickets` is sent again.

### Test 5: Duplicate webhook

1. Send the same successful Cashfree webhook twice.
2. Confirm only one `issued_tickets` row exists.
3. Confirm Telegram does not receive duplicate ticket creation messages.
4. Confirm the webhook event log records the delivery attempts.

### Test 6: Failed payment

1. Start a paid ticket order.
2. Cancel or fail the Cashfree payment.
3. Send `/tickets`.
4. Confirm no active ticket is generated.
5. Confirm the bot returns to the ticket selection list or shows a waiting/failure response according to the current status.

## 21. Troubleshooting

### Telegram shows no ticket list after `/start`

Check:

1. The URL uses `supremv_bot`, not `suprem12_bot`.
2. `CF_BOT_TOKEN` belongs to that bot.
3. `getWebhookInfo` points to the deployed Worker.
4. The webhook path is `/cf-bot/webhook`.
5. The deployed Worker includes the current code.
6. The Worker can reach Supabase.

### Payment says it is still being verified

Check:

1. Cashfree webhook arrived in `cf_webhook_events`.
2. `signature_valid` is true when a webhook secret is configured.
3. Webhook event type is `PAYMENT_SUCCESS_WEBHOOK`.
4. Webhook `order_id` equals `ticket_orders.internal_order_id`.
5. A matching `payment_attempts.ticket_order_id` exists.
6. Cashfree direct status returns `SUCCESS`.
7. Amount in Cashfree equals `ticket_orders.amount_paise / 100`.
8. `CASHFREE_ENVIRONMENT` matches the account used to create the payment.
9. `/tickets` is sent after the Worker is redeployed.

### Ticket appears in Telegram but not website

Check:

1. Website user login token is valid.
2. `ticket_orders.website_user_id` is populated.
3. `issued_tickets.website_user_id` is populated.
4. `users.telegram_id` matches the Telegram user ID.
5. Frontend `VITE_API_BASE_URL` points to the deployed Worker.
6. Browser network requests show `GET /api/user-auth/cf-tickets` returning 200.

### Duplicate tickets

Check:

1. `issued_tickets.ticket_order_id` has a unique constraint.
2. Existing-ticket lookup runs before insertion.
3. The same payment attempt is not manually re-created.
4. Webhook retries return successfully without inserting another row.

## 22. Implementation Rules

- Cashfree is the only paid-payment provider in this flow.
- Telegram never decides payment success.
- The backend never trusts client-provided amounts.
- Every ticket must belong to one `ticket_order`.
- Every paid ticket must reference one `payment_attempt`.
- Ticket generation must be idempotent.
- The webhook and return recovery must call the same ticket-generation logic.
- Admin users monitor tickets; they do not manually create paid tickets.
- Website and Telegram must display the same `ticket_number`.
- Never expose Cashfree secrets or bot tokens in frontend code.
- Restart Vite after changing frontend `.env`.
- Redeploy the Worker after changing backend code or Wrangler variables.

## 23. Definition of Done

The implementation is complete when:

- [ ] Website login works.
- [ ] Website Telegram icon opens `@supremv_bot`.
- [ ] `/start` displays all four ticket types.
- [ ] Free ticket is generated immediately.
- [ ] Paid ticket creates a Cashfree order.
- [ ] Cashfree checkout opens successfully.
- [ ] Cashfree webhook is received and verified.
- [ ] Payment status is checked directly with Cashfree.
- [ ] Paid ticket is automatically generated.
- [ ] Ticket is sent to Telegram.
- [ ] Ticket appears on the website.
- [ ] Ticket appears in admin view.
- [ ] `/tickets` recovers delayed webhook payments.
- [ ] Duplicate webhook delivery cannot create duplicate tickets.
- [ ] No admin manual generation is required.
