# Kaushalya Guest House Backend

Production-oriented Express API backed by PostgreSQL through Supabase. It provides authoritative quotes, atomic room allocation, Razorpay verification, review moderation, booking notifications, and a small authenticated admin API.

## Setup and deployment

1. Use Node.js 20 or newer and run `npm ci`.
2. Copy `.env.example` to `.env` and replace every placeholder. Never expose the service-role key, Razorpay secret, admin secrets, or email token to a browser.
3. Run `migrations/001_production_schema.sql` once in the Supabase SQL editor. It is additive and uses `IF NOT EXISTS`; back up production before every schema migration. The migration creates generated UUID primary keys, payment-order uniqueness, booking idempotency/payment uniqueness, availability/review indexes, and an advisory-lock-protected booking function.
4. Start with `npm start`. Render should use the same start command and `/health` as its health-check path.

The server refuses to start when security-critical configuration is missing. `SUPABASE_ANON_KEY` remains a development compatibility fallback, but production requires `SUPABASE_SERVICE_ROLE_KEY` because public RLS credentials must not be granted administrative access. Generate a unique admin signing secret of at least 32 characters (for example, `openssl rand -base64 48`); never reuse the bootstrap key.

## Configuration

All variables and safe examples are in `.env.example`. Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `ADMIN_SESSION_SECRET`, and `ADMIN_BOOTSTRAP_KEY`. `JWT_SECRET` and the legacy `ADMIN_TOKEN_SECRET` are accepted as signing-secret aliases, but `ADMIN_SESSION_SECRET` is preferred. `ALLOWED_ORIGINS` is a comma-separated exact allowlist; its default permits only `https://kaushalyaguesthouse.github.io` and the documented localhost development origins. Optional configuration covers room prices/inventory, booking limits, payment method names, email webhook delivery, and guest-house contact details; see `.env.example` for every variable.

Room inventory and nightly prices are deliberately centralized in `ROOM_TYPES`, `ROOM_PRICE_<NORMALIZED_ROOM_NAME>`, and `ROOM_INVENTORY_<NORMALIZED_ROOM_NAME>`. The checked-in defaults (Standard ₹1,800/one room and Deluxe ₹2,500/one room) are only operational fallbacks: set them to the guest house's actual inventory and rates before deployment. Every seventh night is free (7 nights = 6 charged; 14 = 12).

Email is optional and provider-neutral: configure `EMAIL_WEBHOOK_URL`, its bearer `EMAIL_WEBHOOK_TOKEN`, sender/admin addresses, and guest-house contact fields. On a verified/confirmed booking, the server posts separate `booking.confirmed` webhook requests for the guest and owner, identified by `recipient_type` and containing the corresponding `guest` or `admin` object. This prevents a provider that handles one message per webhook invocation from silently dropping the owner notification. A missing or invalid `ADMIN_EMAIL` is logged clearly; guest delivery still proceeds. Booking success is not rolled back when notification delivery fails, and `email_sent_at` prevents fully successful delivery sets being repeated. A failed delivery is logged and may be retried by an operations job.

## API

All errors are JSON: `{"success":false,"message":"...","errors":{"field":"..."}}`. Dates are `YYYY-MM-DD`; monetary quote values are rupees while Razorpay order `amount` is paise.

### Public and booking routes

- `GET /` — legacy text response.
- `GET /health` — database-aware health response.
- `GET /rooms` — configured public rate and inventory metadata.
- `POST /quote` — validates a complete booking request and returns authoritative nights, free nights, and total.
- `POST /availability` — accepts `room_type`, `check_in`, and `check_out`; returns `available` and `remaining` using half-open overlap (`existing.check_in < requested.check_out AND existing.check_out > requested.check_in`).
- `POST /create-order` — accepts the complete booking request below. Returns the legacy `order_id`, `amount`, `currency`, and `key_id`, plus `quote`. Send an `Idempotency-Key` header to safely retry.
- `POST /verify-payment` — accepts `razorpay_order_id`, `razorpay_payment_id`, and `razorpay_signature`. Verification is persisted; signature success alone cannot authenticate an unknown order.
- `POST /create-booking` — retains the existing field names and response (`booking_id`, `booking` array). Razorpay bookings additionally require both payment IDs after `/verify-payment`. Pay-later requests require `Idempotency-Key`. A supplied `amount` must exactly match the quote.
- `POST /create-review` — accepts `{customer_name, customer_email, rating, review}`; aliases `name`, `email`, and `review_text` also work. Reviews begin pending.
- `GET /reviews` — approved reviews only; email is never selected.

Example booking/order body:

```json
{
  "customer_name": "Asha Sharma", "email": "asha@example.com", "phone": "+919876543210",
  "room_type": "Standard", "check_in": "2026-08-01", "check_out": "2026-08-08",
  "adults": 2, "children": 1, "payment_type": "Razorpay", "special_request": "Late arrival"
}
```

Example quote response:

```json
{"success":true,"quote":{"nights":7,"complimentary_nights":1,"paid_nights":6,"total_amount":10800}}
```

The frontend must now send full stay/guest data to `/create-order`, retain the returned order ID, call `/verify-payment`, and then call `/create-booking` with the same details and both payment IDs. It must not mark a payment or booking successful from Razorpay's browser callback alone. For pay-later bookings it must generate and retain a unique idempotency key. Handle HTTP 402/409/422 explicitly and refresh availability after a 409.

### Admin routes

Exchange the bootstrap key with `POST /admin/login`, using the frontend-compatible JSON body `{"bootstrapKey":"..."}`. The legacy `{"admin_key":"..."}` body and `X-Admin-Key` header are also accepted. Surrounding whitespace is trimmed, but the UTF-8 value is otherwise compared exactly and case-sensitively. A successful response is exactly `{"success":true,"accessToken":"<signed-session-token>"}`. The access token is a one-hour, HMAC-SHA256 signed bearer token generated with `ADMIN_SESSION_SECRET` (or its documented alias). Send it as `Authorization: Bearer <accessToken>` to:

- `GET /admin/bookings?status=Confirmed&limit=100`
- `GET /admin/bookings/:uuid`
- `PATCH /admin/bookings/:uuid/status` with `{"status":"Pending|Confirmed|Cancelled|Completed"}`
- `GET /admin/reviews` (all reviews, including pending reviews and email for moderation only)
- `PATCH /admin/reviews/:uuid` with `{"status":"approved|rejected"}`
- `DELETE /admin/reviews/:uuid`

Keep the bootstrap key in a password manager and rotate both admin secrets after suspected disclosure. This repository intentionally contains no admin frontend.

## Audit notes and operational limitations

The previous server trusted arbitrary client amounts/statuses, allowed invalid guest data and past/unbounded stays, did not persist payment verification, leaked detailed provider/database errors, logged credential metadata, lacked active booking/review routes in the checked-out file, had no atomic availability control, migrations, admin authentication, email automation, rate limits, database-aware health check, or tests. These paths are now guarded and errors are generic.

Atomic availability depends on applying the migration. Inventory remains category-level because no physical room mapping existed in this repository. Confirm actual prices, room counts, payment-method spelling, and guest capacity with the business before production. Existing legacy rows are preserved; because PostgreSQL cannot safely add `NOT NULL` to unknown dirty production data, strict constraints are applied to new tables and API writes while a later data-cleaning migration should validate legacy booking columns. The provider-neutral email webhook must be implemented/configured externally; no credentials are committed.

Run `npm test` and `npm run check` before deployment. Tests use no database or production credentials.
