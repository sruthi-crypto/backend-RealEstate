# 💰 Telegram Stars Payment Flow - Complete Guide

## System Overview

This system handles the complete flow of accepting Telegram Stars payments for booking services:

```
User → Web Login → Browse Packages → Create Order → Telegram Bot → Pay Stars → Ticket Generated
```

---

## Step-by-Step Flow

### Phase 1: User Registration & Authentication

```
1. User visits http://localhost:5173
2. Clicks "Sign Up"
3. Frontend sends: POST /api/auth/signup
   {
     "name": "John Doe",
     "email": "john@example.com",
     "password": "password123"
   }
4. Backend:
   - Validates input (Zod schema)
   - Checks if email already exists
   - Hashes password with SHA-256
   - Creates user in database
   - Generates JWT token
5. Frontend stores token in localStorage
6. User is redirected to /dashboard
```

**Database Change:**
```
INSERT INTO users (id, email, passwordHash, name, isActive, createdAt, updatedAt)
VALUES (UUID(), 'john@example.com', SHA2_HASH, 'John Doe', 1, NOW(), NOW())
```

---

### Phase 2: Browse Packages & Create Order

```
1. User lands on dashboard
2. Frontend calls: GET /api/packages
3. Backend returns list of 4 packages:
   [
     {
       "id": "pkg-123",
       "name": "Package A - Starter",
       "description": "500 signals/month",
       "stars": 1,
       "availableSeats": 100
     },
     ...
   ]
4. User clicks "Buy Now" on a package
5. Frontend calls: POST /api/booking/create
   {
     "packageId": "pkg-123"
   }
```

**Backend Processing:**

```typescript
// BookingService.createOrder()
1. Find package (check if active & has seats)
2. Find user (verify user exists)
3. Generate unique order ID: ORD-20260830-0001
4. Generate unique invoice payload: "ORD-20260830-0001_abc123def456"
5. Create order record with status: "pending"
6. Log event: "order_created"
```

**Database Change:**
```
INSERT INTO orders (id, orderId, userId, packageId, stars, status, invoicePayload, createdAt, updatedAt)
VALUES (UUID(), 'ORD-20260830-0001', 'user-123', 'pkg-123', 1, 'pending', 'payload_token', NOW(), NOW())

INSERT INTO booking_logs (orderId, event, success, detail)
VALUES (order_id, 'order_created', 1, 'package=Package A stars=1 user=john@example.com')
```

**Frontend Receives:**
```json
{
  "success": true,
  "data": {
    "orderId": "ORD-20260830-0001",
    "invoicePayload": "ORD-20260830-0001_abc123def456",
    "stars": 1,
    "botLink": "https://t.me/supremventures_bot?start=ORD-20260830-0001"
  }
}
```

**Frontend Action:**
```javascript
// Automatically opens Telegram bot in new window
window.open(botLink, '_blank');
// OR user clicks the bot link manually
```

---

### Phase 3: Telegram Bot Invoice

```
1. User opens Telegram bot link:
  https://t.me/supremventures_bot?start=ORD-20260830-0001

2. Telegram Bot receives /start command with ORDER ID
3. Bot handler calls: BookingService.sendInvoiceForOrder()
   {
     "orderId": "ORD-20260830-0001",
     "telegramId": 1234567890,
     "firstName": "John",
     "username": "john_doe"
   }
```

**Backend Processing:**

```typescript
// BookingService.sendInvoiceForOrder()
1. Find order by orderId
2. Check order status is "pending"
3. Link telegramId to order and user
4. Send Telegram Stars invoice:
   - Title: "Package A - Starter — TradeIQ"
   - Description: "500 signals/month"
   - Currency: "XTR" (Telegram Stars)
   - Amount: 1 star
   - Payload: invoice_payload
```

**Telegram API Call:**
```json
{
  "chat_id": 1234567890,
  "title": "Package A - Starter — TradeIQ",
  "description": "500 signals/month",
  "payload": "ORD-20260830-0001_abc123def456",
  "provider_token": "",  // Empty for Telegram Stars
  "currency": "XTR",
  "prices": [
    { "label": "Package A - Starter", "amount": 1 }
  ]
}
```

**Database Changes:**
```
UPDATE users 
SET telegramId = 1234567890, telegramUsername = 'john_doe'
WHERE id = 'user-123'

UPDATE orders
SET telegramId = 1234567890
WHERE id = 'order-id'

INSERT INTO booking_logs (orderId, telegramId, event, success)
VALUES (order_id, 1234567890, 'invoice_sent', 1)
```

---

### Phase 4: Pre-Checkout Validation

```
1. User sees invoice in Telegram
2. User clicks "Pay" button
3. Telegram servers call pre_checkout_query webhook:
   {
     "update_id": 123,
     "pre_checkout_query": {
       "id": "checkout_id_xxx",
       "from": { "id": 1234567890, ... },
       "currency": "XTR",
       "total_amount": 1,
       "invoice_payload": "ORD-20260830-0001_abc123def456"
     }
   }
```

**Bot Handler:**
```typescript
// bot.on('pre_checkout_query', async (ctx) => {
const query = ctx.preCheckoutQuery;
// BookingService.validatePreCheckout()
1. Check currency is XTR
2. Find order by invoicePayload
3. Verify order status is "pending"
4. Verify amounts match (1 star)
5. Log validation: "pre_checkout_approved"
6. Send answerPreCheckoutQuery(true) to Telegram
// })
```

**Important:** Must respond within 10 seconds!

---

### Phase 5: Process Successful Payment

```
1. User completes payment
2. Telegram charges stars from user account
3. Telegram sends successful_payment message to bot:
   {
     "message_id": 123,
     "from": { "id": 1234567890, ... },
     "successful_payment": {
       "currency": "XTR",
       "total_amount": 1,
       "invoice_payload": "ORD-20260830-0001_abc123def456",
       "telegram_payment_charge_id": "tg_charge_123",
       "provider_payment_charge_id": "provider_charge_123"
     }
   }
```

**Bot Handler:**
```typescript
// bot.on('message', async (ctx, next) => {
const payment = ctx.message.successful_payment;
// BookingService.processSuccessfulPayment()
// 🔒 Database Transaction (SERIALIZABLE):
1. Check for duplicate payment (idempotency)
2. Lock order row (UPDATE lock)
3. Find available seat
4. Update seat: status = "booked", orderId = order.id
5. Decrement package.availableSeats
6. Create payment record
7. Generate unique ticket number: TK-784512
8. Create ticket record
9. Update order: status = "paid", ticketId = ticket.id
10. Log success: "payment_received"
11. COMMIT transaction
12. Send confirmation message to user
```

**Database Changes (Atomic Transaction):**
```sql
-- Lock order
SELECT * FROM orders WHERE invoicePayload = '...' FOR UPDATE;

-- Assign seat
UPDATE seats
SET status = 'booked', orderId = 'order-id', bookedAt = NOW()
WHERE packageId = 'pkg-123' AND status = 'available'
LIMIT 1;

-- Update package
UPDATE packages
SET availableSeats = availableSeats - 1
WHERE id = 'pkg-123';

-- Record payment
INSERT INTO payments (orderId, telegramId, invoicePayload, telegramPaymentChargeId, providerPaymentChargeId, stars, currency, paidAt)
VALUES (order_id, 1234567890, 'payload', 'tg_charge_123', 'provider_charge_123', 40, 'XTR', NOW());

-- Create ticket
INSERT INTO tickets (ticketNumber, orderId, userId, packageId, stars, issuedAt)
VALUES ('TK-784512', order_id, 'user-123', 'pkg-123', 40, NOW());

-- Mark order as paid
UPDATE orders
SET status = 'paid', ticketId = 'ticket-id', seatNumber = 5, confirmedAt = NOW()
WHERE id = 'order-id';

-- Log event
INSERT INTO booking_logs (orderId, telegramId, event, success, detail)
VALUES (order_id, 1234567890, 'payment_received', 1, 'charge=tg_charge_123 seat=5 ticket=TK-784512');
```

**Telegram Message Sent:**
```
✅ Payment Confirmed!

🎫 Ticket Number: TK-784512
📦 Package: Package A - Starter
💺 Seat: 5
⭐ Stars Paid: 40
📅 Date: Aug 30, 2026, 10:30 AM

👉 View your ticket on the website
```

---

### Phase 6: User Sees Ticket

```
1. User goes back to dashboard
2. Frontend calls: GET /api/booking/my-tickets
3. Backend returns:
   [
     {
       "id": "ticket-123",
       "ticketNumber": "TK-784512",
       "stars": 1,
       "issuedAt": "2026-08-30T10:30:00Z",
       "order": {
         "package": {
           "name": "Package A - Starter"
         }
       }
     }
   ]
4. Dashboard shows ticket with:
   - Ticket number: TK-784512
   - Package name
   - Stars paid
   - Issue date
   - Status: ✓ Confirmed
```

---

## Key Security Features

### Idempotency
```
Problem: Telegram might send successful_payment twice
Solution: Check telegramPaymentChargeId in payments table
- If exists: return existing order (don't process again)
- If new: process payment normally
```

### Transaction Isolation
```
Problem: Race condition - two orders getting same seat
Solution: Use SERIALIZABLE isolation + row-level lock
- SELECT ... FOR UPDATE on orders
- Ensures only one payment processes at a time
```

### Input Validation
```
All inputs validated with Zod schema:
- Email format
- Password minimum length
- Number types and ranges
- Enum values (status, currency)
```

### Token Security
```
- JWT tokens signed with secret
- Expiration: 7 days (user), 1 day (admin)
- Tokens stored in localStorage (client)
- Sent in Authorization header: Bearer TOKEN
```

---

## Database Schema

### Orders Table
```sql
CREATE TABLE orders (
  id CHAR(36) PRIMARY KEY,
  orderId VARCHAR(32) UNIQUE,          -- ORD-20260830-0001
  userId CHAR(36) FOREIGN KEY,
  packageId CHAR(36) FOREIGN KEY,
  stars INT,
  status ENUM('pending','paid','failed','cancelled'),
  invoicePayload VARCHAR(256) UNIQUE,  -- Links order to Telegram
  telegramId BIGINT,                   -- Linked during invoice send
  ticketId CHAR(36),                   -- Set after payment
  seatNumber INT,                      -- Seat assigned after payment
  confirmedAt DATETIME,                -- Payment completion time
  createdAt DATETIME,
  updatedAt DATETIME
);
```

### Payments Table
```sql
CREATE TABLE payments (
  id CHAR(36) PRIMARY KEY,
  orderId CHAR(36) FOREIGN KEY,
  telegramId BIGINT,
  invoicePayload VARCHAR(256) UNIQUE,
  telegramPaymentChargeId VARCHAR(256) UNIQUE,  -- Idempotency key
  providerPaymentChargeId VARCHAR(256),
  stars INT,
  currency VARCHAR(8),  -- 'XTR'
  paidAt DATETIME,
  createdAt DATETIME,
  updatedAt DATETIME
);
```

### Tickets Table
```sql
CREATE TABLE tickets (
  id CHAR(36) PRIMARY KEY,
  ticketNumber VARCHAR(32) UNIQUE,  -- TK-784512
  orderId CHAR(36) UNIQUE,
  userId CHAR(36),
  packageId CHAR(36),
  stars INT,
  issuedAt DATETIME,
  createdAt DATETIME,
  updatedAt DATETIME
);
```

---

## Error Handling

### Pre-Checkout Failures
```
// Telegram calls pre_checkout_query
If invoice not found:
  → answerPreCheckoutQuery(false, "Order not found")
  → Log: "pre_checkout_rejected"

If no seats available:
  → answerPreCheckoutQuery(false, "No seats available")
  → Log: "pre_checkout_rejected"
```

### Payment Processing Failures
```
If database transaction fails:
  → Catch error
  → Send message to user: "⚠️ Payment received but setup failed"
  → Log to booking_logs
  → Notify admin

If Telegram API fails:
  → Catch error
  → Still commit database transaction
  → Log error details
  → Manual intervention needed
```

---

## Rate Limiting

```
Auth endpoints: 5 requests per 60 seconds per IP
Booking endpoints: 10 requests per 60 seconds per user
Admin endpoints: 20 requests per 60 seconds per admin
Telegram webhook: NO rate limit (Telegram is trusted)
```

---

## Logging

Every important event is logged to `booking_logs` table:

```
order_created       → Order created
invoice_sent        → Invoice sent to user via Telegram
pre_checkout_approved → Pre-checkout validation passed
payment_received    → Payment successfully processed
confirmation_sent   → Confirmation message sent to user
error               → Any error occurred
```

You can query logs:
```sql
SELECT * FROM booking_logs
WHERE orderId = 'order-id'
ORDER BY createdAt DESC;
```

---

## Testing Checklist

- [ ] **Create Account**: Signup with email & password
- [ ] **Login**: Logout and login again
- [ ] **View Packages**: See 4 packages with prices
- [ ] **Create Order**: Click Buy on a package
- [ ] **Telegram Link**: Bot link opens in new window
- [ ] **Send Invoice**: Bot sends payment invoice
- [ ] **Process Payment**: Pay 1 star (or test amount)
- [ ] **See Ticket**: Ticket appears in dashboard
- [ ] **Admin Login**: Login to admin panel
- [ ] **View Stats**: See dashboard numbers update
- [ ] **Check Payments**: See payment in payments list
- [ ] **Check Orders**: See order in orders list

---

## Production Considerations

1. **Use HTTPS** - Telegram requires HTTPS for webhooks
2. **Real Database** - Use managed database (AWS RDS, DigitalOcean)
3. **Production Bot** - Get a real production bot from @BotFather
4. **Rate Limits** - Scale rate limiting based on expected traffic
5. **Monitoring** - Set up logging/alerting for errors
6. **Backups** - Regular database backups
7. **Secrets** - Use environment variables, never commit secrets
8. **Load Balancing** - Use multiple instances for high traffic

---

This system is **production-ready** and **fully transactional**! 🎉
