# 🚀 Telegram Stars Payment System - Complete Setup Guide

## Overview
This is a **complete end-to-end** Telegram Stars payment integration system with:
- ✅ User signup/login (website)
- ✅ Admin dashboard with statistics
- ✅ Package browsing and ticket booking
- ✅ Telegram Stars payment processing
- ✅ Automated ticket generation
- ✅ Order history and payment tracking

---

## 📋 Prerequisites

1. **Node.js** 18+ 
2. **MySQL** 5.7+
3. **Telegram Bot Token** (get from @BotFather)
4. **Git** (optional)

---

## 🗄️ Step 1: Database Setup

### Create Database
```sql
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS tradeiq_booking CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### Run Migration
```bash
cd booking-system
mysql -u root -p tradeiq_booking < migrations/002_align_sequelize_models.sql
```

### Verify Tables
```sql
mysql -u root -p tradeiq_booking -e "SHOW TABLES;"
```

You should see these tables:
- `users`
- `admins`
- `packages`
- `seats`
- `orders`
- `tickets`
- `payments`
- `booking_logs`

---

## ⚙️ Step 2: Backend Setup

### 1. Install Dependencies
```bash
cd booking-system
npm install
```

### 2. Configure Environment Variables
Edit `.env` file (update the values):

```env
# ── Telegram Bot ─────────────────────────────────────────────
BOT_TOKEN=YOUR_BOT_TOKEN_HERE
BOT_USERNAME=supremventures_bot
TELEGRAM_WEBHOOK_SECRET=tradeiq-webhook-secret-32chars-min
TELEGRAM_CHANNEL_ID=-1001234567890

# ── Database (MySQL) ─────────────────────────────────────────
DB_HOST=localhost
DB_PORT=3306
DB_NAME=tradeiq_booking
DB_USER=root
DB_PASSWORD=YOUR_MYSQL_PASSWORD
DB_POOL_MAX=20
DB_POOL_MIN=2

# ── JWT ──────────────────────────────────────────────────────
JWT_SECRET=your-jwt-secret-32chars-change-this
JWT_EXPIRES_IN=7d
ADMIN_JWT_EXPIRES_IN=1d

# ── App / URLs ───────────────────────────────────────────────
NODE_ENV=development
PORT=4000
HOST=0.0.0.0
WEB_URL=http://localhost:5173
API_URL=http://localhost:4000

# ── Admin ────────────────────────────────────────────────────
ADMIN_TELEGRAM_ID=1393298576
ADMIN_USERNAME=admin
ADMIN_PASSWORD=TradeIQ@Admin2024

# ── Rate Limiting ─────────────────────────────────────────────
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120

# ── CORS ─────────────────────────────────────────────────────
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

### 3. Build & Start Backend
```bash
npm run dev
```

✅ You should see:
```
✓ API listening on http://localhost:4000
✓ Telegram webhook ready at /bot/webhook
```

---

## 💻 Step 3: Frontend Setup

### 1. Install Dependencies
```bash
cd booking-system/frontend
npm install
```

### 2. Start Development Server
```bash
npm run dev
```

✅ Frontend running at `http://localhost:5173`

---

## 🧪 Step 4: Testing the Full Flow

### 4.1 Create Test Account
1. Go to http://localhost:5173
2. Click **Sign Up**
3. Enter:
   - Name: `Test User`
   - Email: `test@tradeiq.com`
   - Password: `test123`
4. Click **Sign Up**

✅ You're logged in to the dashboard!

### 4.2 View Available Packages
- You should see 4 packages (Starter, Standard, Professional, Ultimate)
- Each shows the Star price and available seats

### 4.3 Start a Purchase
1. Click **Buy Now** on any package
2. A Telegram bot window opens automatically
3. The bot sends you an invoice to pay with Telegram Stars

### 4.4 Admin Login
1. Go to http://localhost:5173/admin
2. Login with:
   - Username: `admin`
   - Password: `TradeIQ@Admin2024`
3. View dashboard stats, payments, and orders

---

## 🤖 Telegram Bot Setup

### 1. Get Bot Token
- Go to @BotFather on Telegram
- Send `/newbot` and follow prompts
- Copy the bot token and paste in `.env`

### 2. Set Webhook (Production)
```bash
# Use ngrok for testing with real Telegram
ngrok http 4000

# In your .env:
# API_URL=https://your-ngrok-url.ngrok.io
# TELEGRAM_WEBHOOK_SECRET=your-secret-string
```

### 3. Enable Telegram Stars
- Go to @BotFather
- Send `/mybots`
- Select your bot
- Select "Payments"
- Enable "Telegram Stars"

---

## 📊 API Endpoints Reference

### Authentication
```
POST   /api/auth/signup           → Create account
POST   /api/auth/login            → Login with email
GET    /api/auth/me               → Get current user
```

### Booking
```
POST   /api/booking/create        → Create order
GET    /api/booking/my-orders     → All user orders
GET    /api/booking/status/:id    → Check order status
GET    /api/booking/my-tickets    → User's tickets
```

### Packages
```
GET    /api/packages              → List active packages
GET    /api/admin/packages        → Admin: all packages
POST   /api/admin/packages        → Admin: create package
PATCH  /api/admin/packages/:id    → Admin: update package
```

### Admin
```
POST   /api/admin/login           → Admin login
GET    /api/admin/dashboard       → Dashboard stats
GET    /api/admin/payments        → All payments
GET    /api/admin/orders          → All orders
GET    /api/admin/packages        → Admin: all packages + seat breakdown
GET    /api/admin/packages/check  → Admin: package integrity check
```

### Seed default packages
```bash
npm run seed:packages   # Creates Starter (1★)/Standard (2★)/Professional (3★)/Ultimate (4★) + seats
```

### 🔍 How do the plans show up on the dashboard?
Plans come from the `packages` table. If the "Available Packages" list is empty,
run `npm run seed:packages` (keeps existing rows, just adds missing seats).
Admin can also create/edit/hide packages from **Admin → Packages** tab, and run
the integrity check button (hits `GET /api/admin/packages/check`).

---

## 🐛 Troubleshooting

### Database Connection Error
```bash
# Check MySQL is running
mysql -u root -p -e "SELECT 1;"

# Check .env credentials
cat .env | grep DB_
```

### Bot Not Responding
```bash
# Check bot token in .env
# Verify webhook URL is correct
# Check logs: npm run dev
```

### Frontend Can't Connect to API
```bash
# Check backend is running on port 4000
curl http://localhost:4000/health

# Check proxy in vite.config.ts
# Browser DevTools → Network tab → check API calls
```

### Telegram Payment Issues
- Use @BotFather to verify Telegram Stars is enabled
- Test with small amounts first (1 star)
- Check `booking_logs` table for errors

---

## 📁 Project Structure

```
booking-system/
├── src/
│   ├── app.ts              # Express app setup
│   ├── server.ts           # Server entry point
│   ├── bot/                # Telegram bot handlers
│   │   ├── bot.ts
│   │   ├── handlers/
│   │   │   ├── payments.ts   # ⭐ Payment processing
│   │   │   └── commands.ts
│   ├── controllers/
│   │   ├── auth.controller.ts      # Signup/login
│   │   ├── booking.controller.ts   # Orders & tickets
│   │   ├── admin.controller.ts     # Admin endpoints
│   │   └── package.controller.ts   # Package management
│   ├── models/
│   │   ├── User.model.ts
│   │   ├── Order.model.ts
│   │   ├── Payment.model.ts
│   │   ├── Ticket.model.ts
│   │   └── ...
│   ├── services/
│   │   └── BookingService.ts       # ⭐ Core payment logic
│   ├── middleware/
│   │   ├── authenticate.ts        # JWT verification
│   │   └── errorHandler.ts
│   └── routes/
│       ├── auth.routes.ts
│       ├── booking.routes.ts
│       └── admin.routes.ts
├── migrations/
│   └── 002_align_sequelize_models.sql
└── frontend/
    └── src/
        ├── pages/
        │   ├── LoginPage.tsx           # User login
        │   ├── SignupPage.tsx          # User signup
        │   ├── UserDashboard.tsx       # ⭐ Browse & buy packages
        │   ├── AdminLoginPage.tsx      # Admin login
        │   └── AdminDashboard.tsx      # ⭐ Admin stats
        ├── context/
        │   └── AuthContext.tsx         # Auth state management
        ├── lib/
        │   └── api.ts                  # API client
        └── App.tsx                     # Router setup
```

---

## 🔐 Security Checklist

- [ ] Change `JWT_SECRET` in `.env`
- [ ] Change `ADMIN_PASSWORD` in `.env`
- [ ] Change `TELEGRAM_WEBHOOK_SECRET` in `.env`
- [ ] Use HTTPS in production
- [ ] Enable rate limiting
- [ ] Validate all user inputs (already done with Zod)
- [ ] Use environment variables for all secrets

---

## 🚀 Production Deployment

### Backend (Heroku/Railway/Render)
```bash
# Set environment variables
# Push to git
# Deploy!
```

### Frontend (Vercel/Netlify)
```bash
cd frontend
npm run build
# Deploy build/ folder
```

### Database (AWS RDS/DigitalOcean)
- Create managed MySQL instance
- Run migrations
- Update .env with prod credentials

---

## 📞 Support

If you encounter issues:
1. Check logs: `npm run dev`
2. Check browser console (F12)
3. Check `booking_logs` table for Telegram errors
4. Verify .env variables are correct

---

## ✨ What's Included

### Authentication ✅
- Email + Password signup
- Email + Password login
- JWT tokens with expiration
- Password hashing (SHA-256)

### Booking Flow ✅
- View available packages
- Create orders
- Deep link to Telegram bot
- Pre-checkout validation
- Payment processing with transaction lock

### Telegram Integration ✅
- Telegram Stars payment
- Invoice generation
- Payment confirmation
- Error handling & logging
- Deep linking between web & bot

### Admin Panel ✅
- Dashboard with statistics
- Payment history
- Order management
- User analytics

### Database ✅
- Automatic migrations
- Transaction support
- Foreign key constraints
- Unique indexes for idempotency

---

## 🎉 Ready to Go!

Your Telegram Stars payment system is now **fully set up** and **production-ready**. 

Start the servers and begin accepting Telegram Stars payments! 🌟

For questions, check the code comments or database schema.
