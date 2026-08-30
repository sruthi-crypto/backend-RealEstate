# 🔌 API Reference - All Endpoints

Quick reference for all API endpoints in the system.

---

## 🔐 Authentication Endpoints

### Signup
```
POST /api/auth/signup
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePassword123"
}

Response 201:
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid-xxx",
      "name": "John Doe",
      "email": "john@example.com",
      "telegramId": null
    },
    "token": "jwt_token_here"
  }
}

Response 400:
{
  "success": false,
  "error": "Email already exists"
}
```

### Login
```
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "SecurePassword123"
}

Response 200:
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid-xxx",
      "name": "John Doe",
      "email": "john@example.com",
      "telegramId": null,
      "lastLoginAt": "2026-08-30T10:30:00Z"
    },
    "token": "jwt_token_here"
  }
}

Response 401:
{
  "success": false,
  "error": "Invalid email or password"
}
```

### Get Current User
```
GET /api/auth/me
Authorization: Bearer jwt_token_here

Response 200:
{
  "success": true,
  "data": {
    "id": "uuid-xxx",
    "name": "John Doe",
    "email": "john@example.com",
    "telegramId": 1234567890,
    "isActive": true,
    "createdAt": "2026-08-30T10:00:00Z"
  }
}

Response 401:
{
  "success": false,
  "error": "Unauthorized"
}
```

---

## 📦 Package Endpoints

### List Packages
```
GET /api/packages
(No authentication required)

Response 200:
{
  "success": true,
  "data": [
    {
      "id": "pkg-123",
      "name": "Starter",
      "description": "500 signals/month",
      "stars": 1,
      "totalSeats": 100,
      "availableSeats": 87,
      "isActive": true,
      "sortOrder": 1,
      "createdAt": "2026-08-30T00:00:00Z"
    },
    ...
  ]
}
```

---

## 🎫 Booking Endpoints

### Create Order
```
POST /api/booking/create
Authorization: Bearer jwt_token_here
Content-Type: application/json

{
  "packageId": "pkg-123"
}

Response 201:
{
  "success": true,
  "data": {
    "orderId": "ORD-20260830-0001",
    "invoicePayload": "ORD-20260830-0001_abc123def456",
    "stars": 1,
    "botLink": "https://t.me/Sai_test_45_bot?start=ORD-20260830-0001"
  }
}

Response 400:
{
  "success": false,
  "error": "Package not found or no seats available"
}
```

### Get My Orders
```
GET /api/booking/my-orders
Authorization: Bearer jwt_token_here

Response 200:
{
  "success": true,
  "data": [
    {
      "id": "order-id-123",
      "orderId": "ORD-20260830-0001",
      "stars": 1,
      "status": "pending",
      "package": {
        "name": "Starter",
        "description": "500 signals/month"
      },
      "createdAt": "2026-08-30T10:15:00Z",
      "confirmedAt": null
    },
    {
      "id": "order-id-456",
      "orderId": "ORD-20260830-0002",
      "stars": 2,
      "status": "paid",
      "package": {
        "name": "Standard",
        "description": "1000 signals/month"
      },
      "createdAt": "2026-08-30T11:00:00Z",
      "confirmedAt": "2026-08-30T11:05:00Z"
    }
  ]
}
```

### Check Order Status
```
GET /api/booking/status/:orderId
Authorization: Bearer jwt_token_here

Example: /api/booking/status/ORD-20260830-0001

Response 200:
{
  "success": true,
  "data": {
    "orderId": "ORD-20260830-0001",
    "status": "pending",
    "stars": 1,
    "createdAt": "2026-08-30T10:15:00Z",
    "confirmedAt": null
  }
}

Response 404:
{
  "success": false,
  "error": "Order not found"
}
```

### Get My Tickets
```
GET /api/booking/my-tickets
Authorization: Bearer jwt_token_here

Response 200:
{
  "success": true,
  "data": [
    {
      "id": "ticket-123",
      "ticketNumber": "TK-784512",
      "stars": 1,
      "issuedAt": "2026-08-30T11:05:00Z",
      "order": {
        "orderId": "ORD-20260830-0001",
        "package": {
          "name": "Starter",
          "description": "500 signals/month"
        }
      }
    },
    {
      "id": "ticket-456",
      "ticketNumber": "TK-512847",
      "stars": 2,
      "issuedAt": "2026-08-30T11:30:00Z",
      "order": {
        "orderId": "ORD-20260830-0002",
        "package": {
          "name": "Standard",
          "description": "1000 signals/month"
        }
      }
    }
  ]
}
```

---

## 👨‍💼 Admin Endpoints

### Admin Login
```
POST /api/admin/login
Content-Type: application/json

{
  "username": "admin",
  "password": "TradeIQ@Admin2024"
}

Response 200:
{
  "success": true,
  "data": {
    "admin": {
      "id": "admin-123",
      "username": "admin",
      "telegramId": null
    },
    "token": "jwt_admin_token_here"
  }
}

Response 401:
{
  "success": false,
  "error": "Invalid username or password"
}
```

### Dashboard Statistics
```
GET /api/admin/dashboard
Authorization: Bearer admin_jwt_token_here

Response 200:
{
  "success": true,
  "data": {
    "totalOrders": 42,
    "paidOrders": 38,
    "pendingOrders": 4,
    "totalUsers": 35,
    "totalStarsEarned": 2840,
    "totalTickets": 38,
    "recentPayments": [
      {
        "id": "payment-123",
        "orderId": "ORD-20260830-0001",
        "stars": 1,
        "paidAt": "2026-08-30T11:05:00Z"
      },
      ...
    ]
  }
}
```

### Get All Payments
```
GET /api/admin/payments?page=1&limit=20
Authorization: Bearer admin_jwt_token_here

Response 200:
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "payment-123",
        "orderId": "ORD-20260830-0001",
        "invoicePayload": "ORD-20260830-0001_abc123...",
        "telegramPaymentChargeId": "tg_charge_123",
        "providerPaymentChargeId": "provider_charge_123",
        "stars": 1,
        "currency": "XTR",
        "paidAt": "2026-08-30T11:05:00Z"
      },
      ...
    ],
    "total": 38,
    "page": 1,
    "pages": 2
  }
}
```

### Get All Orders
```
GET /api/admin/orders?page=1&limit=20&status=all
Authorization: Bearer admin_jwt_token_here

Query Parameters:
- page: 1 (default)
- limit: 20 (default)
- status: all | pending | paid | failed | cancelled

Response 200:
{
  "success": true,
  "data": {
    "orders": [
      {
        "id": "order-id-123",
        "orderId": "ORD-20260830-0001",
        "userId": "user-123",
        "stars": 1,
        "status": "paid",
        "package": {
          "name": "Starter"
        },
        "createdAt": "2026-08-30T10:15:00Z",
        "confirmedAt": "2026-08-30T11:05:00Z"
      },
      ...
    ],
    "total": 42,
    "page": 1,
    "pages": 3
  }
}
```

### Get All Users
```
GET /api/admin/users?page=1&limit=20
Authorization: Bearer admin_jwt_token_here

Response 200:
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "user-123",
        "name": "John Doe",
        "email": "john@example.com",
        "telegramId": 1234567890,
        "isActive": true,
        "lastLoginAt": "2026-08-30T10:30:00Z",
        "createdAt": "2026-08-30T09:00:00Z"
      },
      ...
    ],
    "total": 35,
    "page": 1,
    "pages": 2
  }
}
```

### Get All Tickets
```
GET /api/admin/tickets?page=1&limit=20
Authorization: Bearer admin_jwt_token_here

Response 200:
{
  "success": true,
  "data": {
    "tickets": [
      {
        "id": "ticket-123",
        "ticketNumber": "TK-784512",
        "orderId": "ORD-20260830-0001",
        "stars": 1,
        "issuedAt": "2026-08-30T11:05:00Z",
        "user": {
          "name": "John Doe",
          "email": "john@example.com"
        },
        "package": {
          "name": "Starter"
        }
      },
      ...
    ],
    "total": 38,
    "page": 1,
    "pages": 2
  }
}
```

### Get Booking Logs
```
GET /api/admin/logs?orderId=ORD-20260830-0001
Authorization: Bearer admin_jwt_token_here

Response 200:
{
  "success": true,
  "data": [
    {
      "id": "log-123",
      "orderId": "ORD-20260830-0001",
      "telegramId": null,
      "event": "order_created",
      "success": true,
      "detail": "package=Starter stars=1 user=john@example.com",
      "createdAt": "2026-08-30T10:15:00Z"
    },
    {
      "id": "log-124",
      "orderId": "ORD-20260830-0001",
      "telegramId": 1234567890,
      "event": "invoice_sent",
      "success": true,
      "detail": "via Telegram Bot",
      "createdAt": "2026-08-30T10:16:00Z"
    },
    {
      "id": "log-125",
      "orderId": "ORD-20260830-0001",
      "telegramId": 1234567890,
      "event": "payment_received",
      "success": true,
      "detail": "charge=tg_charge_123 seat=5 ticket=TK-784512",
      "createdAt": "2026-08-30T11:05:00Z"
    }
  ]
}
```

### Get Admin Packages
```text
GET /api/admin/packages
Authorization: Bearer admin_jwt_token_here

Response 200:
{
  "success": true,
  "data": [
    {
      "id": "pkg-123",
      "name": "Starter",
      "description": "Basic access — 500 signals/month, email support",
      "stars": 1,
      "totalSeats": 100,
      "availableSeats": 100,
      "isActive": true,
      "sortOrder": 1,
      "seatRows": 100,
      "seatBreakdown": { "available": 100, "booked": 0, "reserved": 0 }
    },
    ...
  ]
}
```

### Check Packages Integrity (Admin)
```text
GET /api/admin/packages/check
Authorization: Bearer admin_jwt_token_here

Use this to verify every package is healthy (seats count + available seats match).
Response 200 (all healthy):
{
  "success": true,
  "data": {
    "ok": true,
    "count": 4,
    "packages": [
      {
        "id": "pkg-123",
        "name": "Starter",
        "stars": 1,
        "isActive": true,
        "totalSeats": 100,
        "availableSeats": 100,
        "seatBreakdown": { "available": 100, "booked": 0, "reserved": 0 },
        "ok": true,
        "problems": []
      },
      ...
    ]
  }
}

If a package is broken, "ok" is false and "problems" lists what to fix, e.g.:
  "problems": ["seat rows (99) != totalSeats (100)"]
```

---

## 🤖 Telegram Webhook Endpoints

### Webhook Handler
```
POST /bot/webhook

(Telegram sends webhook data automatically)
No authentication needed - validated by Telegram signature

Expects update_id in body from Telegram API
```

---

## 📊 Error Responses

All errors follow this format:

```json
{
  "success": false,
  "error": "Error message here",
  "statusCode": 400
}
```

### Common Status Codes
- `200`: OK - Request successful
- `201`: Created - Resource created
- `400`: Bad Request - Invalid input
- `401`: Unauthorized - Missing/invalid token
- `403`: Forbidden - Insufficient permissions
- `404`: Not Found - Resource doesn't exist
- `409`: Conflict - Resource already exists
- `429`: Too Many Requests - Rate limit exceeded
- `500`: Server Error - Internal server error

---

## 🔑 Authentication

All protected endpoints require this header:

```
Authorization: Bearer YOUR_JWT_TOKEN_HERE
```

Get tokens from:
- `/api/auth/login` - User token
- `/api/auth/signup` - User token
- `/api/admin/login` - Admin token

---

## 📡 Rate Limiting

Applies to all endpoints (Telegram webhook exempt):

| Endpoint | Limit |
|----------|-------|
| `/api/auth/*` | 5 requests/min per IP |
| `/api/booking/*` | 10 requests/min per user |
| `/api/admin/*` | 20 requests/min per admin |
| `/api/packages` | 20 requests/min per IP |

Response when rate limited:
```json
{
  "success": false,
  "error": "Too many requests, please try again later",
  "statusCode": 429
}
```

---

## 🧪 Testing Endpoints

You can test these endpoints with:

**cURL:**
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@tradeiq.com","password":"test123"}'
```

**Postman:**
- Import: `docs/Telegram-Stars-Payment.postman_collection.json`

**Insomnia:**
- Similar collection format supported

**Frontend:**
- Use `src/lib/api.ts` functions

---

## 📱 Response Headers

All responses include:

```
Content-Type: application/json
X-Response-Time: 42ms (response time)
X-RateLimit-Limit: 10 (per request type)
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 1693382400 (Unix timestamp)
```

---

**Happy API-ing! 🚀**
