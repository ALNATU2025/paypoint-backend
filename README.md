# Paypoint API

This is the backend for the Paypoint mobile app. It handles:
- user accounts (email + password login) with a 4-digit transaction PIN
- a naira wallet (credited by an admin for now; card funding comes later)
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

## API

All responses look like `{ "success": true, "data": … }` or `{ "success": false, "message": "…" }`.
Send `Authorization: Bearer <token>` on every route except register, login and health.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | | Database state, and whether VTPass is configured (`missing` lists any unset key names) |
| POST | `/api/auth/register` | `fullName, email, phone, password` | Returns `{ token, user }`. Email must be unique. Phone can be any format and length |
| POST | `/api/auth/login` | `email, password` | Returns `{ token, user }` |
| GET | `/api/auth/me` | | The user, including wallet `balance` and `hasPin` |
| PUT | `/api/auth/pin` | `pin, currentPin?` | Sets or changes the 4-digit PIN |
| GET | `/api/cable/providers` | | dstv, gotv, startimes |
| GET | `/api/cable/:serviceID/packages` | | `[{ code, name, amount }]` from VTPass |
| POST | `/api/cable/verify` | `serviceID, billersCode` | `customerName, currentBouquet, dueDate, renewalAmount…` |
| POST | `/api/cable/pay` | **Change:** `serviceID, billersCode, variationCode, months?, pin`<br>**Renew:** `serviceID, billersCode, mode: "renew", pin` | Returns `{ transaction, balance }`. Status is `success`, `pending` or `failed` (failed is refunded) |
| POST | `/api/cable/requery/:id` | | Updates a pending payment |
| GET | `/api/wallet` | | `{ balance }` |
| GET | `/api/transactions` | `?type=cable\|funding&limit=` | Newest first |
| GET | `/api/transactions/:id` | | |
| GET | `/api/admin/stats` | | **Admin.** Users, sales today and in total, pending payments, wallet totals, VTPass balance |
| GET | `/api/admin/users` | `?q=` | **Admin.** Search users by name, email or phone |
| GET | `/api/admin/users/:id` | | **Admin.** User and recent transactions |
| POST | `/api/admin/users/:id/unlock-pin` | | **Admin.** Clear a PIN lockout |
| POST | `/api/admin/wallet/credit` | `userId` / `email` / `phone`, `amount`, `note?` | **Admin.** Add money to a wallet |
| POST | `/api/admin/wallet/debit` | `userId` / `email` / `phone`, `amount`, `note?` | **Admin.** Correct a wallet (never goes below ₦0) |
| GET | `/api/admin/transactions` | `?status=&type=` | **Admin.** All users' transactions |
| POST | `/api/admin/transactions/:id/requery` | | **Admin.** Settle any pending payment |

**Admin access.** Log in with an email listed in `ADMIN_EMAILS` (default `payonpointng@gmail.com`; separate several with commas), and the app shows the Admin dashboard. Scripts can use the header `x-admin-key: <ADMIN_API_KEY>` instead.

- **`months`** (1–12) applies to DStv and GOtv. StarTimes is always 1 month.
- **Change vs renew** follows the VTPass TV docs:
  - **Change** sends `variation_code` and, for DStv/GOtv, `subscription_type: "change"` and `quantity`. It sends **no `amount`**, so VTPass charges the bouquet price; if an amount were sent, VTPass would top up the decoder with exactly that amount.
  - **Renew** (DStv and GOtv only) sends `subscription_type: "renew"` with `amount` set to the decoder's `Renewal_Amount`. The backend fetches that amount from merchant-verify itself.
- **GOtv due dates** (`02-FEB-25`) are converted to `YYYY-MM-DD`.
- **StarTimes `WrongBillersCode: true`** is treated as an invalid number.

### Testing in the VTPass sandbox
Set `VTPASS_MODE=sandbox` and use your sandbox credentials. These smartcard numbers simulate each outcome:

| Number | Outcome |
|---|---|
| `1212121212` | Verified, payment successful |
| `201000000000` | Payment pending (resolved later with requery) |
| `300000000000` | Timeout (left pending; the money stays held until requery) |
| `400000000000` / `500000000000` | No response / unexpected response (left pending) |
| any other number | Verification or payment fails (wallet refunded) |

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
   - `VTPASS_API_KEY` and `VTPASS_SECRET_KEY`, from your VTPass dashboard under Settings → API Keys. Use these exact names, and paste the values without quotes. `VTPASS_PUBLIC_KEY` is optional.
   - `ADMIN_API_KEY`, any long random text. It lets you credit user wallets until card funding is added.
4. **VTPass account.** Your VTPass account must be funded, because VTPass debits *your* VTPass wallet for each subscription.
5. **Deploy.** Then open `https://paypoint-backend-aj52.onrender.com/health`. It should show `"db":"connected"` and `"configured":true` for VTPass. If any key is missing, its name appears under `missing`.

### Funding a wallet (until card funding is added)
```bash
curl -X POST https://paypoint-backend-aj52.onrender.com/api/admin/wallet/credit \
  -H "x-admin-key: YOUR_ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"email":"customer@example.com","amount":5000,"note":"Cash deposit"}'
```

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

The tests run against a fake VTPass server. They cover sign-up and login, PINs and lockout, live prices, change and renew, successful, failed and pending payments, refunds, requery, configuration checks and per-user data scoping. GitHub Actions runs them on every push, with a real MongoDB.
