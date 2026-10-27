# Paypoint API

This is the backend for the Paypoint mobile app. It handles:
- user accounts with a 4-digit transaction PIN
- a naira wallet, funded by card or bank through **Paystack**
- **DStv, GOtv and StarTimes** subscriptions through **VTPass**

It's built with Node.js 20+, Express and MongoDB.

## How a cable payment works

```
App ──► POST /api/cable/verify ──► VTPass merchant-verify  (shows the customer name)
App ──► GET  /api/cable/:id/packages ─► VTPass service-variations (live prices, cached 10 min)
App ──► POST /api/cable/pay {pin} ──► check PIN ─► price from VTPass ─► debit wallet ─► VTPass pay
                                         │
                       delivered ◄───────┼──► failed: wallet refunded automatically
                                         └──► pending: money held; POST /api/cable/requery/:id settles it
```

The rules that protect the money:
- **Prices** always come from VTPass. Any amount the app sends is ignored.
- **The wallet is debited atomically**, so two payments at once can't overspend it.
- **A failed payment** is refunded exactly once.
- **The VTPass `request_id`** follows VTPass's required format: the date and time in Lagos (`YYYYMMDDHHmm`), then a unique suffix.
- **The transaction PIN** is hashed with bcrypt. Five wrong PINs lock payments for 15 minutes.
- **Wallet funding** is confirmed directly with Paystack, from the verify call, the browser redirect or the signed webhook. Each payment is credited once.

## API

All responses look like `{ "success": true, "data": … }` or `{ "success": false, "message": "…" }`.
Send `Authorization: Bearer <token>` on every route except register, login, health and the webhook.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | | Database state and whether VTPass and Paystack are configured |
| POST | `/api/auth/register` | `fullName, phone, email?, password` | Returns `{ token, user }` |
| POST | `/api/auth/login` | `phone, password` | Returns `{ token, user }` |
| GET | `/api/auth/me` | | The user, including wallet `balance` and `hasPin` |
| PUT | `/api/auth/pin` | `pin, currentPin?` | Sets or changes the 4-digit PIN |
| GET | `/api/cable/providers` | | dstv, gotv, startimes |
| GET | `/api/cable/:serviceID/packages` | | `[{ code, name, amount }]` from VTPass |
| POST | `/api/cable/verify` | `serviceID, billersCode` | `customerName, currentBouquet, dueDate, renewalAmount…` |
| POST | `/api/cable/pay` | `serviceID, billersCode, variationCode, months?, pin, customerName?` | Returns `{ transaction, balance }`. Status is `success`, `pending` or `failed` (failed is refunded) |
| POST | `/api/cable/requery/:id` | | Updates a pending payment |
| GET | `/api/wallet` | | `{ balance }` |
| POST | `/api/wallet/fund/initialize` | `amount` | Returns `{ authorizationUrl, reference }`; open the URL to pay |
| GET | `/api/wallet/fund/verify/:reference` | | Confirms the payment with Paystack and credits the wallet |
| GET | `/api/transactions` | `?type=cable\|funding&limit=` | Newest first |
| GET | `/api/transactions/:id` | | |
| POST | `/api/webhooks/paystack` | | Set this URL in Paystack, under Settings → API Keys & Webhooks |
| POST | `/api/admin/wallet/credit` | `phone, amount, note?` | Header `x-admin-key`. Only active when `ADMIN_API_KEY` is set |

`months` (1–12) applies to DStv and GOtv. StarTimes is always 1 month.

## Deploy on Render

1. **Database.** Create a free MongoDB Atlas cluster.
   - Allow access from anywhere (`0.0.0.0/0`), because Render's outbound IPs change.
   - Copy the connection string.
2. **Settings.** In your Render service (`paypoint-backend-aj52`), open **Settings**.
   - Point it at this repo, branch `main`.
   - **Build command:** `npm ci || npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/health`
3. **Environment variables.** Under **Environment**, add every variable from `.env.example`. At minimum:
   - `MONGODB_URI`
   - `JWT_SECRET` (a long random string)
   - `NODE_ENV=production`
   - `VTPASS_MODE=live`
   - `VTPASS_API_KEY`, `VTPASS_PUBLIC_KEY` and `VTPASS_SECRET_KEY`, from your VTPass dashboard under Settings → API Keys
   - `PAYSTACK_SECRET_KEY` (`sk_live_…`)
   - `PUBLIC_URL=https://paypoint-backend-aj52.onrender.com`
4. **VTPass account.** Your VTPass account must be funded, because VTPass debits *your* VTPass wallet for each subscription.
5. **Paystack webhook.** In Paystack, set the webhook URL to `https://paypoint-backend-aj52.onrender.com/api/webhooks/paystack`.
6. **Deploy.** Then open `https://paypoint-backend-aj52.onrender.com/health`. It should show `"db":"connected"` and `"configured":true` for VTPass.

On the free plan, Render puts the service to sleep after 15 minutes without traffic, and the first request then takes about 30–50 seconds. The app waits long enough for that.

## Run locally

```bash
cp .env.example .env    # fill it in
npm install
node --env-file=.env src/server.js
```

## Tests

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/paypoint_test npm test
```

The tests run against fake VTPass and Paystack servers. They cover sign-up and login, PINs and lockout, live prices, successful, failed and pending payments, refunds, requery, Paystack funding with a signed webhook, and per-user data scoping. GitHub Actions runs them on every push, with a real MongoDB.
