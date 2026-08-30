# TradeIQ Booking System

Production-ready Telegram Stars booking platform.
Node.js · Express · MySQL · Redis · Telegraf · Bull · PM2 · NGINX · Docker

---

## Full Booking Flow

```
Website "Book Seat" button
        ↓
POST /api/booking/create  (telegramId + packageId)
        ↓
Backend creates pending Order in MySQL
        ↓
Bot sends Telegram Stars invoice to user's chat
        ↓
User taps ⭐ Pay inside Telegram
        ↓
Telegram → pre_checkout_query → Backend validates → OK
        ↓
Telegram → successful_payment → Backend processes
        ↓
MySQL SERIALIZABLE transaction:
  - Lock order row (FOR UPDATE)
  - Lock next available seat (FOR UPDATE)
  - Mark seat as booked
  - Decrement package.availableSeats
  - Insert payment record
  - Update order status = paid
        ↓
Generate QR Code (base64 PNG)
        ↓
Send confirmation message + QR to user in Telegram
        ↓
Post announcement to Telegram Channel
        ↓
Frontend polls GET /api/booking/status/:invoicePayload
        ↓
Shows Booking ID + Seat Number to user
```

---

## Project Structure

```
booking-system/
├── src/
│   ├── bot/
│   │   ├── bot.ts                  # Telegraf singleton
│   │   ├── index.ts                # Handler registration + webhook/polling
│   │   └── handlers/
│   │       ├── commands.ts         # /start /plans /mybooking /help + callbacks
│   │       └── payments.ts         # pre_checkout_query + successful_payment
│   ├── config/
│   │   ├── database.ts             # MySQL + Sequelize
│   │   ├── env.ts                  # Zod-validated env vars
│   │   ├── logger.ts               # Winston
│   │   └── redis.ts                # ioredis client
│   ├── controllers/
│   │   ├── admin.controller.ts     # Dashboard, payments, orders, users
│   │   ├── booking.controller.ts   # Create, lookup, status
│   │   ├── package.controller.ts   # Public + admin package CRUD
│   │   └── webhook.controller.ts   # Telegram webhook receiver
│   ├── middleware/
│   │   ├── authenticate.ts         # Admin JWT guard
│   │   ├── errorHandler.ts         # Global error handler
│   │   └── rateLimiter.ts          # express-rate-limit zones
│   ├── models/
│   │   ├── Admin.model.ts
│   │   ├── BookingLog.model.ts
│   │   ├── Order.model.ts
│   │   ├── Package.model.ts
│   │   ├── Payment.model.ts
│   │   ├── Seat.model.ts
│   │   └── User.model.ts
│   ├── queues/
│   │   └── bookingQueue.ts         # Bull queue definition
│   ├── routes/
│   │   ├── admin.routes.ts
│   │   ├── booking.routes.ts
│   │   ├── index.ts
│   │   ├── package.routes.ts
│   │   └── webhook.routes.ts
│   ├── services/
│   │   ├── BookingService.ts       # Core business logic
│   │   └── PackageService.ts       # Package + seat management
│   ├── utils/
│   │   ├── ApiError.ts
│   │   ├── ApiResponse.ts
│   │   ├── asyncHandler.ts
│   │   └── jwt.ts
│   ├── workers/
│   │   └── bookingWorker.ts        # Bull worker process
│   ├── app.ts                      # Express app factory
│   └── server.ts                   # Bootstrap entry point
├── migrations/
│   └── 001_init.sql                # Full MySQL schema + seed data
├── nginx/
│   └── tradeiq-booking.conf        # NGINX reverse proxy config
├── logs/                           # Winston log files (auto-created)
├── .env                            # Environment variables
├── docker-compose.yml
├── Dockerfile
├── ecosystem.config.js             # PM2 config
├── package.json
└── tsconfig.json
```

---

## Environment Variables

| Variable                | Description                                      |
|-------------------------|--------------------------------------------------|
| `BOT_TOKEN`             | From @BotFather                                  |
| `BOT_USERNAME`          | Bot username without @                           |
| `TELEGRAM_WEBHOOK_SECRET` | Random secret for webhook validation           |
| `TELEGRAM_CHANNEL_ID`   | Channel ID e.g. `-1001234567890`                 |
| `DB_HOST`               | MySQL host                                       |
| `DB_PORT`               | MySQL port (default 3306)                        |
| `DB_NAME`               | Database name                                    |
| `DB_USER`               | MySQL user                                       |
| `DB_PASSWORD`           | MySQL password                                   |
| `REDIS_HOST`            | Redis host                                       |
| `REDIS_PORT`            | Redis port (default 6379)                        |
| `JWT_SECRET`            | Min 24 chars random string                       |
| `ADMIN_USERNAME`        | Admin dashboard username                         |
| `ADMIN_PASSWORD`        | Admin dashboard password (min 8 chars)           |
| `ADMIN_TELEGRAM_ID`     | Your Telegram user ID (from @userinfobot)        |
| `WEB_URL`               | Frontend URL                                     |
| `API_URL`               | Backend public URL (used for webhook registration)|

---

## Local Development Setup

```bash
# 1. Install dependencies
cd booking-system
npm install

# 2. Start MySQL (or use Docker)
docker run -d --name mysql \
  -e MYSQL_ROOT_PASSWORD=pass \
  -e MYSQL_DATABASE=tradeiq_booking \
  -p 3306:3306 mysql:8.0

# 3. Start Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 4. Copy and fill .env
cp .env .env.local
# Edit .env with your BOT_TOKEN, DB credentials, etc.

# 5. Run migration (optional — Sequelize auto-syncs in dev)
mysql -u root -p tradeiq_booking < migrations/001_init.sql

# 6. Start dev server (polling mode, auto-restart)
npm run dev

# 7. Start worker in a separate terminal
npm run worker
```

---

## BotFather Setup

```
1. Open @BotFather → /mybots → select your bot
2. Bot Settings → Domain → set to: localhost  (dev) or yourdomain.com (prod)
3. Bot Settings → Payments → Telegram Stars → Enable
4. That's it — provider_token is empty string for Stars
```

---

## Production Deployment

### 1. Server (Ubuntu 22.04)

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2
npm install -g pm2

# Install MySQL 8
sudo apt install mysql-server -y
sudo mysql_secure_installation

# Install Redis
sudo apt install redis-server -y

# Install NGINX
sudo apt install nginx -y
```

### 2. Deploy App

```bash
git clone <your-repo> /var/www/tradeiq-booking
cd /var/www/tradeiq-booking/booking-system

npm install
npm run build

# Run migration
mysql -u root -p tradeiq_booking < migrations/001_init.sql

# Copy and fill production .env
cp .env .env.production
nano .env  # set NODE_ENV=production, real BOT_TOKEN, DB creds, API_URL

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # follow the printed command to enable auto-start
```

### 3. NGINX

```bash
sudo cp nginx/tradeiq-booking.conf /etc/nginx/sites-available/tradeiq-booking
# Edit the file: replace yourdomain.com with your real domain
sudo ln -s /etc/nginx/sites-available/tradeiq-booking /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4. SSL (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

### 5. Register Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://yourdomain.com/bot/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

---

## Docker Deployment

```bash
# Fill .env first, then:
docker-compose up -d

# View logs
docker-compose logs -f api
```

---

## API Reference

### Public Endpoints

| Method | Path                                  | Description                        |
|--------|---------------------------------------|------------------------------------|
| GET    | `/health`                             | Health check                       |
| GET    | `/api/packages`                       | List active packages               |
| POST   | `/api/booking/create`                 | Create order + send invoice        |
| GET    | `/api/booking/lookup/:bookingId`      | Look up booking by ID              |
| GET    | `/api/booking/status/:invoicePayload` | Poll payment status                |
| POST   | `/bot/webhook`                        | Telegram webhook (production)      |

### Admin Endpoints (Bearer JWT required)

| Method | Path                            | Description                  |
|--------|---------------------------------|------------------------------|
| POST   | `/api/admin/login`              | Get admin JWT                |
| GET    | `/api/admin/dashboard`          | Summary stats                |
| GET    | `/api/admin/payments`           | Payment history (paginated)  |
| GET    | `/api/admin/orders`             | All orders (paginated)       |
| GET    | `/api/admin/seats/:packageId`   | Seat map for a package       |
| GET    | `/api/admin/logs`               | Booking audit logs           |
| GET    | `/api/admin/users`              | All users                    |
| GET    | `/api/packages/admin`           | All packages (incl. inactive)|
| POST   | `/api/packages/admin`           | Create package + seed seats  |
| PATCH  | `/api/packages/admin/:id`       | Update package               |
| POST   | `/api/packages/admin/:id/seats` | Add more seats               |
| GET    | `/api/admin/packages`           | All packages + seat breakdown|
| GET    | `/api/admin/packages/check`     | Package integrity check      |

### Example: Create Booking (from website)

```http
POST /api/booking/create
Content-Type: application/json

{
  "telegramId": 123456789,
  "packageId": "uuid-of-package",
  "firstName": "Sai",
  "username": "saikrishna"
}
```

Response:
```json
{
  "success": true,
  "message": "Invoice sent to Telegram. Open the bot to pay.",
  "data": {
    "orderId": "uuid",
    "bookingId": "TRQ-20240601-0001",
    "invoicePayload": "book_uuid_uuid",
    "botDeepLink": "https://t.me/Sai_test_45_bot",
    "stars": 1
  }
}
```

---

## Seat Allocation — No Duplicates Guarantee

The seat assignment uses `SERIALIZABLE` isolation + `SELECT ... FOR UPDATE`:

```sql
-- Inside a SERIALIZABLE transaction:
SELECT * FROM seats
WHERE packageId = ? AND status = 'available'
ORDER BY seatNumber ASC
LIMIT 1
FOR UPDATE;          -- Blocks all other concurrent transactions

UPDATE seats SET status = 'booked', orderId = ? WHERE id = ?;
UPDATE packages SET availableSeats = availableSeats - 1 WHERE id = ?;
```

This guarantees zero duplicate seat assignments even under 100,000 concurrent users.

---

## Telegram Channel Integration

After every successful payment the bot posts to your channel:

```
🎟 New Booking!

📋 Booking ID: TRQ-20240601-0001
📦 Package: Package A
💺 Seat: 42
📅 Mon, 01 Jun 2024 10:30:00 GMT
```

Set `TELEGRAM_CHANNEL_ID` in `.env` to your channel's numeric ID.
The bot must be an **admin** of the channel to post.

To get your channel ID:
1. Forward any message from the channel to @userinfobot
2. It shows the channel ID (starts with -100...)

---

## Scalability Notes

- PM2 cluster mode runs one process per CPU core — handles 100k+ concurrent HTTP requests
- MySQL connection pool: 20 connections per process
- Redis Bull queue: async post-payment tasks (QR, channel notify) don't block the payment flow
- `SERIALIZABLE` transactions + `FOR UPDATE` locks prevent any duplicate seat assignment
- Idempotency: `telegramPaymentChargeId` has a UNIQUE constraint — duplicate webhooks are ignored
- All logs written to `logs/` with rotation (Winston)
