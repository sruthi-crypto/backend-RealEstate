# 🤖 Telegram Stars Payments — Reusable Setup Guide

A complete, copy-paste-friendly guide for accepting **Telegram Stars** payments in **any project** (web app, bot, service) — built from the reference implementation in this repository (`TradeIQ Booking System`).

Telegram Stars is Telegram's in-app currency. Users buy ⭐ Stars inside Telegram and pay **instantly with zero card details** — you (the developer) get paid by Telegram automatically. No Stripe, no gateway, no KYC for the user. Perfect for digital products: plans, subscriptions, tickets, boosts, digital goods.

---

## 📑 Table of Contents

1. [How it works (the flow)](#1-how-it-works)
2. [Prerequisites](#2-prerequisites)
3. [Step 1 — Create a bot with @BotFather](#3-step-1--create-a-bot)
4. [Step 2 — Enable Stars payments on the bot](#4-step-2--enable-stars-payments)
5. [Step 3 — Add the bot library to your code](#5-step-3--add-the-bot-library)
6. [Step 4 — Deep-link users from web → bot](#6-step-4--deep-linking-website-to-bot)
7. [Step 5 — Send the Stars invoice](#7-step-5--send-a-stars-invoice)
8. [Step 6 — Validate the pre-checkout (before money moves)](#8-step-6--validate-pre-checkout)
9. [Step 7 — Fulfill the order on successful payment](#9-step-7--fulfill-the-order)
10. [Webhook vs polling mode](#10-webhook-vs-polling)
11. [The environment variables you need](#11-environment-variables)
12. [Code map — reference files in this repo](#12-code-map--where-everything-lives-in-this-repo)
13. [Testing checklist](#13-testing-checklist)
14. [Troubleshooting](#14-troubleshooting)
15. [Important rules & gotchas](#15-important-rules--gotchas)

---

## 1. How it works

```
User on your website → clicks "Buy"
        ↓
Your backend creates an order in your database (status = pending)
        ↓
User is redirected to your Telegram bot → t.me/YourBot?start=ORDER_ID
        ↓
Bot loads the order and sends a Stars invoice to the user's chat
        ↓
User taps ⭐ Pay inside Telegram
        ↓
Telegram asks YOUR SERVER: pre_checkout_query  (validate now!)
        ↓
You approve → Telegram charges Stars from user's balance
        ↓
Telegram sends YOUR SERVER: successful_payment  (money is in!)
        ↓
You mark the order paid and deliver the product (ticket, code, access…)
```

**Two mental models that make everything click:**

- **`pre_checkout_query`** = "User pressed Pay. Should I charge them?." You answer `true` (charge) or `false` (reject, with a reason). This happens *before* any Stars leave the user.
- **`successful_payment`** = "Charged ✅." This is the moment of truth — *this* is where you grant access / create the ticket. Never grant access anywhere else.

---

## 2. Prerequisites

| Thing | Where to get it |
|---|---|
| A Telegram account | @telegram |
| `BOT_TOKEN` | @BotFather → `/newbot` |
| Stars payment enabled | @BotFather → `/mybots` → bot → **Payments** |
| A public HTTPS URL (production only) | Needed only for webhook mode (Ngrok works for testing) |
| Node.js 18+ (if using JS/TS) | nodejs.org — or use any language with a Telegram Bot API library |

No merchant account, no credit-card processor, no tax forms from Telegram to start. Telegram handles the whole payment rail.

---

## 3. Step 1 — Create a bot

1. Open **@BotFather** on Telegram.
2. Send `/newbot`.
3. Enter a display name (e.g. `My Store Bot`).
4. Enter a **unique username** ending in `bot` (e.g. `my_store_krishna_bot`).
5. @BotFather replies with your **HTTP API token** like:
   ```
   8123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
6. Save it. This is your `BOT_TOKEN` — keep it secret (server-side only).

> 📌 The bot icon, description and commands are all set via `/set...` commands in BotFather.

---

## 4. Step 2 — Enable Stars payments

This is the **easiest step people miss** — without it, `sendInvoice` with Stars fails.

1. In **@BotFather** send `/mybots`.
2. Tap your bot.
3. Tap **Bot Settings** → **Payments**.
4. Tap **Enable** (store)… and choose a payment provider:
   - For Telegram Stars, Telegram itself is the provider — there is often **no extra provider token** needed. Enable the "Telegram Stars" option when shown.
5. Done. The bot can now send Star invoices.

---

## 5. Step 3 — Add the bot library

Pick the library for your language. This repo uses **Node.js + Telegraf**:

```bash
npm install telegraf
```

**Minimal server skeleton** (same shape as `src/bot/bot.ts` + `src/bot/index.ts` in this repo):

```typescript
// bot.ts
import { Telegraf } from 'telegraf';

export const bot = new Telegraf(process.env.BOT_TOKEN!);

// bot/index.ts — register handlers (sections 6–9) then:
if (process.env.NODE_ENV === 'production') {
  // Webhook mode — Telegram pushes updates to a public URL (see section 10)
  await bot.telegram.setWebhook(`${process.env.API_URL}/bot/webhook`);
} else {
  // Polling mode — easiest for local dev (no public URL needed)
  await bot.telegram.deleteWebhook();
  await bot.launch();
}
```

> In *any* other language: use the [Telegram Bot API](https://core.telegram.org/bots/api) directly (`sendInvoice`, `answerPreCheckoutQuery`…). The concepts below are identical.

---

## 6. Step 4 — Deep-linking website → bot

**Why:** the Stars invoice is *sent by the bot* to the user's chat. The website can't open a payment dialog — so you send the user to the bot, and the bot recognizes *which order* they want to pay for.

1. When the user clicks **Buy**, your backend:
   - creates an order row `(status: 'pending')` in your DB,
   - generates a unique **payload token** that maps 1:1 to that order
     (e.g. `ORD-20260830-0001_x7f2k9q`).
2. Return a deep link to your frontend:
   ```
   https://t.me/<BOT_USERNAME>?start=<ORDER_ID_OR_PAYLOAD>
   ```
   This repo returns `botLink` from `POST /api/booking/create`.
3. The frontend does `window.open(botLink, '_blank')`.
4. In the bot, the `/start` handler receives the payload:

```typescript
bot.start(async (ctx) => {
  const payload = ctx.startPayload?.trim(); // "ORD-20260830-0001"
  if (payload) {
    await sendInvoiceForOrder({ orderId: payload, telegramId: ctx.from!.id });
    return;
  }
  await ctx.reply('👋 Welcome! Pick a plan on our website.');
});
```

> Use a **tamper-proof token**: include a random suffix so users can't pay an arbitrary small amount. Your backend re-validates everything from the payload (section 8).

---

## 7. Step 5 — Send a Stars invoice

Inside the `/start` handler (or any command), call `sendInvoice` with currency `XTR`:

```typescript
import { Markup } from 'telegraf';

await bot.telegram.sendInvoice(
  telegramId,                          // chat id (the user who paid)
  {
    title: 'Starter Plan — TradeIQ',
    description: '500 signals/month, email support',
    payload: invoicePayload,           // ← your unique order token (max 128 chars)
    provider_token: '',                // ← EMPTY for Telegram Stars
    currency: 'XTR',                   // ← Stars
    prices: [{ label: 'Starter Plan', amount: 1 }],   // amount in Stars (whole number)
    start_parameter: 'pay',            // required by Telegram for invoices
  },
  Markup.inlineKeyboard([Markup.button.pay('⭐ Pay 1 Star')]),
);
```

---

## 8. Step 6 — Validate pre-checkout

Right after the user taps **Pay**, Telegram sends a `pre_checkout_query`. **You must answer it within 10 seconds** or the payment is cancelled. Validate *everything* before approving:

```typescript
bot.on('pre_checkout_query', async (ctx) => {
  const q = ctx.preCheckoutQuery;
  try {
    // 1. Currency must be XTR
    if (q.currency !== 'XTR') return ctx.answerPreCheckoutQuery(false, 'Currency mismatch');

    // 2. Find the order by q.invoice_payload
    const order = await findOrderByPayload(q.invoice_payload);
    if (!order) return ctx.answerPreCheckoutQuery(false, 'Order not found');

    // 3. Must still be pending
    if (order.status !== 'pending') return ctx.answerPreCheckoutQuery(false, 'Order already processed');

    // 4. Amount must match the stored price
    if (q.total_amount !== order.stars) return ctx.answerPreCheckoutQuery(false, 'Amount mismatch');

    // 5. Optionally confirm seats are still available BEFORE charging
    if (order.package.availableSeats <= 0) return ctx.answerPreCheckoutQuery(false, 'No seats left');

    await ctx.answerPreCheckoutQuery(true);  // ✅ charge them
  } catch (err) {
    await ctx.answerPreCheckoutQuery(false, 'Payment unavailable, try again');
  }
});
```

Every `false` rejection shows the message to the user in the chat. Log every decision (the `booking_logs` table does this in the reference repo).

---

## 9. Step 7 — Fulfill the order on successful payment

This is where money actually lands. Telegram sends a `successful_payment` **message** to your bot:

```typescript
bot.on('message', async (ctx) => {
  const pm = ctx.message?.successful_payment;
  if (!pm) return;

  const payload = pm.invoice_payload;
  const chargeId = pm.telegram_payment_charge_id;   // idempotency key
  const stars = pm.total_amount;

  try {
    // Wrap in a DB transaction:
    //   - lock the order row FOR UPDATE
    //   - if chargeId already processed → skip (duplicates are possible!)
    //   - lock the next available seat / stock row
    //   - write your Payment record
    //   - create/issue the digital product (ticket number, access code…)
    //   - set order.status = 'paid', confirmedAt = now
    await fulfillOrder({ payload, chargeId, stars });

    await ctx.reply('✅ Payment confirmed! Here is your ticket/access.');
  } catch (err) {
    console.error('Fulfillment failed', err);
    await ctx.reply('⚠️ Payment received, but setup failed. Contact support.');
  }
});
```

**Critical rules:**
- **Idempotency:** Telegram may redeliver updates. Use `telegram_payment_charge_id` as a unique column — never double-issue a ticket.
- **Ordering:** commit the DB transaction *first*, then send the confirmation to the user. If Telegram messaging fails, don't roll back a valid payment.
- Store `telegramId` on the user/order to link future payments.

---

## 10. Webhook vs polling

| Mode | When | Setup |
|---|---|---|
| **Polling** | Local development | Nothing — the bot calls `getUpdates` itself. Run `bot.launch()`. |
| **Webhook** | Production | Telegram calls `POST https://your-api.com/bot/webhook` with each update. Requires a **public HTTPS URL** (no self-signed certs). |

Webhook setup:
```typescript
await bot.telegram.setWebhook('https://api.yourproject.com/bot/webhook', {
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, // optional but recommended
});
```
Your Express app (or any HTTP server) exposes that route with **raw JSON body** and returns `200 OK` fast (Telegram retries on non-200).

---

## 11. Environment variables

```env
# Telegram
BOT_TOKEN=8123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # from @BotFather
BOT_USERNAME=my_store_krishna_bot
TELEGRAM_WEBHOOK_SECRET=random-secret-string

# Your own backend
PORT=4000
API_URL=https://api.yourproject.com        # public, for webhook mode
WEB_URL=https://yourproject.com            # used in deep links / confirmation messages
```

(Your DB — Postgres/MySQL — variables are separate from Telegram and not listed here.)

---

## 12. Code map — where everything lives in this repo

| Concept | File |
|---|---|
| Bot + handler registration | `src/bot/bot.ts`, `src/bot/index.ts` |
| `/start` deep link + welcome | `src/bot/handlers/commands.ts` |
| pre_checkout + successful_payment | `src/bot/handlers/payments.ts` |
| Create order + send invoice + fulfill | `src/services/BookingService.ts` |
| Public packages endpoint | `src/controllers/package.controller.ts` |
| Admin package mgmt + integrity check | `src/controllers/admin.controller.ts` |
| DB tables (Postgres) | `migrations/001_postgres_init.sql` |
| Seed packages/seats | `scripts/seed-packages.js` |
| API reference | `API_ROUTES.md` |
| Full payment flow walkthrough | `PAYMENT_FLOW.md` |

---

## 13. Testing checklist

- [ ] `sendInvoice` returns an invoice to your chat (Stars enabled in BotFather)
- [ ] Tapping **Pay** with wrong amount gets rejected (`pre_checkout` false path)
- [ ] Paying the correct amount triggers `successful_payment`
- [ ] The same successful payment delivered twice does **not** create two tickets (idempotency)
- [ ] User sees `✅ Payment confirmed` in the chat
- [ ] Order shows `paid` + a ticket/access was created in your DB
- [ ] Your website dashboard now shows the order/ticket

---

## 14. Troubleshooting

| Symptom | Fix |
|---|---|
| `chat not found` on invoice | User didn't `/start` the bot yet — open the deep link first (that's why `?start=` exists) |
| `currency XTR` / `provider_token` error | Stars not enabled in @BotFather → **Payments → Enable**. Verify it's a bot username, not a private channel-test bot. |
| `pre_checkout_query` rejected right after send | You have 10s to answer — respond fast, check logs for the rejection reason |
| Payment succeeded but no ticket | Wrong/old `invoice_payload`, or fulfillment threw — check `booking_logs` / your logs, then re-run fulfillment from the charge id |
| Duplicate tickets | Missing idempotency on `telegram_payment_charge_id` — add a unique constraint / `ON CONFLICT DO NOTHING` |
| Production: no updates received | Webhook not set, or no HTTPS / self-signed cert → set a real webhook URL |
| `duplicate invoice payload` on create | Payload must be unique per order (random suffix) — two orders can't share a payload |

---

## 15. Important rules & gotchas

1. **`provider_token: ''`** for Stars — it is empty, not a Stripe-style token.
2. **Amount = whole Stars** (min 1). No decimals for `XTR`.
3. **Payload max 128 chars**, must be unique per invoice.
4. **Answer pre-checkout within 10 seconds** — Telegram's timeout is hard.
5. **`start_parameter` is required** when sending an invoice.
6. **Treat `successful_payment` as final truth**, never frontend state.
7. **Idempotency is mandatory** — Telegram retries webhook deliveries.
8. Keep `BOT_TOKEN` in environment variables, never in client code.
9. Telegram deducts its **service fee** from Stars revenue; Stars convert to TON/USDT in the bot's Fragments wallet (or via Wallet) — check current payout terms in Telegram docs.
10. In webhook mode, return `200` quickly; queue heavy work afterwards (the reference uses Bull + PM2 to scale).

---

### 📚 Related docs in this repo
- `API_ROUTES.md` — every endpoint (public, user, admin) with JSON examples
- `PAYMENT_FLOW.md` — step-by-step walkthrough of the full Stars payment lifecycle
- `SETUP.md` — environment + local run instructions
- `README.md` — project overview & architecture

**That's it — copy the concepts, swap in your package names/prices, and you're accepting Telegram Stars! ⭐**