# Fere Monetization, Auth, and Billing Plan

## Goal

Ship Fere with:

- A usable free tier
- A paid `Pro` plan at `$12/month`
- No BYOK flow
- No OpenAI API key in the desktop app
- Server-side enforcement for auth, billing, quotas, and AI usage

This plan assumes:

- `Detect` remains free because it is deterministic and local-first
- `Autopilot` remains free for deterministic safe actions that do not use AI
- `Explain` and any future AI-backed investigation features run through Fere's backend

---

## Product Plans

### Free

- Unlimited local `Detect`
- Unlimited deterministic `Autopilot`
- `Explain` limited to `5 AI calls/day`
- Hard per-request cap:
  - `6,000` input tokens
  - `800` output tokens
- No BYOK
- Requires Fere account for AI usage

### Pro

- Price: `$12/month`
- Unlimited local `Detect`
- Unlimited deterministic `Autopilot`
- `Explain` with larger request budget
- Monthly AI allowance:
  - up to `300` AI calls/month
  - hard per-request cap:
    - `12,000` input tokens
    - `1,500` output tokens
- Priority queueing / lower latency if needed later
- Room for future premium features:
  - deeper root-cause investigation
  - longer AI history
  - project/team sharing

---

## Pricing Logic

Using `gpt-5.4-mini` pricing as of April 2, 2026:

- Input: `$0.75 / 1M tokens`
- Output: `$4.50 / 1M tokens`

Reference:

- https://openai.com/api/pricing/
- https://developers.openai.com/api/docs/models/gpt-5.4-mini

### Estimated raw model cost

#### Free plan worst-case per AI call

- `6,000` input = about `$0.0045`
- `800` output = about `$0.0036`
- Total worst-case = about `$0.0081`

At `5 calls/day`, worst-case monthly raw model cost is roughly:

- `150 calls/month`
- `150 * $0.0081 = $1.215`

This is acceptable for a free tier if actual average usage stays well below cap.

#### Pro plan worst-case per AI call

- `12,000` input = about `$0.009`
- `1,500` output = about `$0.00675`
- Total worst-case = about `$0.01575`

At `300 calls/month`, worst-case monthly raw model cost is roughly:

- `300 * $0.01575 = $4.725`

At `$12/month`, this leaves margin for:

- Stripe fees
- auth backend
- database/storage
- abuse/rate limiting
- monitoring/logging

This is a workable starting plan.

---

## Core Architecture

The desktop app must never call OpenAI directly for paid AI features.

### Required request flow

1. User signs into Fere in the Electron app
2. Electron stores only a Fere session token
3. Electron sends AI requests to Fere backend
4. Backend authenticates user
5. Backend checks subscription + quota
6. Backend trims and validates payload
7. Backend calls OpenAI using server-side secret
8. Backend stores usage metrics
9. Backend returns answer to Electron

### Non-negotiable rule

Do not ship `OPENAI_API_KEY` in `.env`, app bundle, preload, renderer, or main process for distributed builds.

Development can still use local env values temporarily, but production must go through the backend.

---

## Auth Plan

Use account-based auth for any cloud-backed feature.

### Recommended auth stack

- Auth provider: Clerk, Auth0, or Supabase Auth
- Recommendation: `Clerk` or `Supabase Auth`

Reason:

- fast Electron-compatible signup/signin
- email magic links and password flows
- session handling
- webhooks for user lifecycle events

### Required user model

Store a user record in Fere backend with:

- `id`
- `email`
- `auth_provider_user_id`
- `plan` (`free`, `pro`)
- `stripe_customer_id`
- `stripe_subscription_id`
- `subscription_status`
- `ai_calls_used_today`
- `ai_calls_used_this_month`
- `input_tokens_used_this_month`
- `output_tokens_used_this_month`
- `current_period_start`
- `current_period_end`
- `created_at`
- `updated_at`

### Session model

- Desktop app authenticates user
- Backend verifies auth token on every cloud request
- Backend issues or trusts a short-lived session/JWT
- All AI endpoints require auth

---

## Billing Plan

Use Stripe subscriptions.

### Stripe objects

- One product: `Fere Pro`
- One monthly price: `$12/month`

### Required Stripe flows

- Create checkout session
- Redirect user to Stripe Checkout
- Handle successful checkout return
- Receive Stripe webhook events
- Update user plan in backend
- Allow customer portal for cancel/update payment method

### Stripe webhook events to handle

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

### Plan status rules

- `free`:
  - no active subscription
- `pro`:
  - active paid subscription
- downgrade on:
  - canceled and expired
  - failed payment after grace period

---

## Quota Enforcement

Do not trust the client for quota or token limits.

All enforcement must happen server-side.

### Free limits

- `5` AI calls per rolling day or calendar day
- `6,000` max input tokens/request
- `800` max output tokens/request

### Pro limits

- `300` AI calls per billing month
- `12,000` max input tokens/request
- `1,500` max output tokens/request

### Additional safety budgets

Also maintain a backend dollar guardrail:

- free user monthly raw model budget target: `~$1.25`
- pro user monthly raw model budget target: `~$5.00`

If usage reaches internal budget thresholds early, backend can:

- reduce max output tokens
- require retry later
- block further AI calls until reset

### Quota checks per request

Before sending to OpenAI:

1. authenticate user
2. resolve plan
3. estimate input tokens
4. reject if request exceeds plan cap
5. reject if daily/monthly call budget exceeded
6. reject if projected monthly spend exceeds internal guardrail

After model response:

1. record actual input tokens
2. record actual output tokens
3. compute estimated cost
4. persist usage event

---

## Token Strategy

Do not send raw, unbounded runtime context into the model.

### Requirements

- Trim topology data before sending
- Include only scoped services relevant to the question
- Cap log excerpts aggressively
- Remove duplicate routes, ports, and edges
- Prefer summaries over full dumps

### Recommended prompt construction

- system prompt:
  - concise explanation of Fere role
  - short safety rules
- context block:
  - scoped services
  - relevant findings
  - small route summary
  - limited logs or file excerpts
- user prompt:
  - direct question

### Output control

- Free: `max_output_tokens = 800`
- Pro: `max_output_tokens = 1500`

Keep answers short by default. Output tokens are the expensive side.

---

## Backend Services

Minimum production backend responsibilities:

- auth/session verification
- Stripe integration
- user + subscription storage
- AI request proxying
- token counting and usage ledger
- rate limiting
- audit logs
- abuse detection

### Suggested backend endpoints

- `POST /auth/session`
- `GET /me`
- `POST /billing/checkout`
- `POST /billing/portal`
- `POST /webhooks/stripe`
- `GET /usage`
- `POST /ai/explain`

### Suggested persistence tables

#### `users`

- identity and plan metadata

#### `subscriptions`

- Stripe-linked billing state

#### `usage_events`

- one row per AI request:
  - `user_id`
  - `feature`
  - `model`
  - `input_tokens`
  - `output_tokens`
  - `estimated_cost_usd`
  - `created_at`

#### `daily_usage_counters`

- fast enforcement for free-tier daily limits

---

## Electron App Changes

### Remove direct production dependency on OpenAI key

Current local behavior still reads `OPENAI_API_KEY` from the app process. Production should move to:

- app calls Fere backend for AI
- backend calls OpenAI

### New renderer flows

- sign up / sign in
- account status
- upgrade to Pro
- manage subscription
- usage meter

### New UI states

- signed out
- free plan
- pro plan
- daily limit reached
- monthly limit reached
- payment failed / subscription expired

---

## Security Requirements

- Never expose OpenAI secret to desktop clients
- Verify auth on every backend AI call
- Rate limit by user ID and IP
- Store Stripe webhook secret server-side only
- Sign and verify webhook payloads
- Log usage without storing sensitive user payloads unnecessarily
- Redact secrets from runtime context before sending to backend/model

---

## Rollout Plan

### Phase 1: Backend foundation

- choose auth provider
- create backend service
- create user and usage tables
- integrate Stripe
- implement webhook handling

### Phase 2: AI proxy

- add `/ai/explain`
- add token estimation and quota enforcement
- add usage ledger
- move production AI calls off desktop env key

### Phase 3: Desktop account UX

- sign in / sign up UI
- plan and usage display
- upgrade flow
- billing portal button

### Phase 4: Launch guardrails

- alerting on abnormal spend
- internal dashboards for:
  - active users
  - conversion
  - AI cost/user
  - limit hit rates

---

## Open Questions

- Which auth provider to use: Clerk vs Supabase Auth
- Which backend stack to use: existing Node service vs separate API service
- Whether free tier should require sign-in before any AI usage
- Whether Pro should be `300 calls/month` or a token-based monthly pool
- Whether advanced investigation mode should be a Pro-only feature from day 1

---

## Recommended Decision Set

For the first paid release:

- Plan names:
  - `Free`
  - `Pro`
- Price:
  - `Pro = $12/month`
- AI model:
  - `gpt-5.4-mini`
- AI limits:
  - Free: `5 calls/day`, `6000 in`, `800 out`
  - Pro: `300 calls/month`, `12000 in`, `1500 out`
- Auth:
  - required for any AI feature
- Billing:
  - Stripe subscriptions
- Production AI architecture:
  - server-side proxy only

This is the lowest-risk version that protects the API key, supports monetization, and keeps unit economics sane.
