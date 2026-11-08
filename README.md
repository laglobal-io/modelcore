# ModelCore

Marketplace for proprietary AI training data, with a talent network and a referral partner program.
Next.js (App Router) + Supabase (Postgres, Auth, RLS) + Stripe Connect, deployed on Vercel.

**Status:** referral system complete end to end (database, tracking, attribution, commissions, payouts, partner and admin dashboards) plus magic-link onboarding. Marketplace pages from the prototype are the next build step.

## Referral system

| Step | Where | What happens |
|---|---|---|
| Partner claims a code | `/partners/dashboard` → `become_partner()` | Named link `modelcore.io/r/levay`, plus an auto-generated code-only link like `modelcore.io/r/n3knncb`. Both credit the same partner |
| Visitor clicks link | `src/app/r/[code]/route.ts` | Click logged (hashed IP, UTM, country), first-touch cookie set for 90 days, redirect to `?to=` path |
| `?ref=code` on any page | `src/middleware.ts` | Routed through `/r/code`, same tracking |
| Visitor onboards | `src/app/api/onboarding/route.ts` | Magic link sent; intake answers and referral cookie ride along as signup metadata |
| First sign-in creates the user | `handle_new_user()` trigger | Profile created; `attribute_profile()` credits the partner for 24 months from first touch |
| Colleague joins later | same trigger | Same company email domain inherits the attribution (free-mail domains excluded) |
| Deal releases from escrow | `api/deals/[id]/confirm-delivery` → `deals_referral_hook()` | Seller paid via Stripe transfer; commissions created per referred side: 25% of the 10% fee |
| Refund or cancel | Stripe webhook → trigger | Unpaid commissions voided |
| Payout run (1st and 15th) | `api/cron/partner-payouts` | Approved commissions batched, Stripe transfer to partner, marked paid; failures released for retry |
| Display | `/partners/dashboard`, `/admin/referrals`, `GET /api/partners/me` | Stats, funnel, 30-day clicks, referred companies with stage, commissions, transfers |

### Rules built in
- **First touch wins.** A later link never overwrites an existing referral cookie, and a member is never re-attributed.
- **No self-referral.** Partners get nothing for signing up themselves or anyone at their own company domain.
- **One partner per side.** If the same partner referred both buyer and seller, they're paid once per deal (`one_commission_per_partner_per_deal` setting). Different partners on each side are each paid.
- **Rounding.** Fee rounds half-up to the cent, commission rounds down.
- **Privacy.** Partners never see raw clicks (IP hashes, user agents); they see aggregates and the referred company's name and stage.
- **Tunable without a deploy.** `app_settings`: `platform_fee_bps` (1000), `partner_share_bps` (2500), `attribution_window_months` (24), `min_payout_cents` (5000). Per-partner override: `partners.share_bps`.

### Tables
`partners`, `referral_clicks`, `referral_attributions`, `referral_commissions`, `partner_payouts`, `app_settings` (plus core: `profiles`, `listings`, `data_requests`, `nda_agreements`, `deals`). All have RLS.

## Sample room

Buyers request a sample after both sides sign the NDA. Sellers either upload files to a private
Supabase Storage bucket (`samples`) or paste an https link to their own storage. Buyers never get a
storage URL: they open `/api/samples/:id/download`, the database authorizes and logs the access,
and the route redirects to a signed URL that lives 5 minutes.

- Schema and rules: `supabase/migrations/20261108000003_samples.sql` (state functions, RLS, access log)
- Limits: 5 GB per file, 20 GB and 25 files per sample, 5 downloads per file, access for 7, 14 or 30 days (`src/lib/samples/core.ts`)
- Uploads go browser to Storage with signed upload URLs (`src/lib/samples/client.ts`), so file bytes never pass through Vercel
- `GET /api/cron/sample-expiry` (hourly) ends expired samples and deletes their files, plus uploads abandoned for a day
- Revoke, "not a fit" and "need another sample" delete stored files immediately
- Buyers confirm deletion when a sample ends without a funded deal; sellers see that confirmation and the full access log
- ModelCore stores samples only. Full datasets still go seller to buyer.

Supabase plan note: the free plan caps uploads at 50 MB per file. Raise the global upload limit on a
paid plan to match `file_size_limit` on the bucket. Files over ~6 MB upload more reliably with
resumable (TUS) uploads; swap `uploadToSignedUrl` for a TUS client when large samples are common.

| Route | Who | What |
|---|---|---|
| `POST /api/samples` | buyer | Request a sample (`listingId`, `request`, `acceptTerms`) |
| `POST /api/samples/:id/files` | seller | Start an upload, returns a signed upload URL |
| `POST /api/samples/:id/files/:fileId/complete` | seller | Verify the object and record its size |
| `DELETE /api/samples/:id/files/:fileId` | seller | Remove a file before sharing |
| `POST /api/samples/:id/share` | seller | Share uploads or a link, set expiry |
| `POST /api/samples/:id/decline` | seller | Decline with a reason |
| `POST /api/samples/:id/revoke` | seller | End access now and delete files |
| `GET /api/samples/:id/download?file=` | buyer | Logged, short-lived download or link redirect |
| `POST /api/samples/:id/review` | buyer | Ratings, issues, notes, verdict |
| `POST /api/samples/:id/confirm-deletion` | buyer | Certify the sample was deleted |

## Data enrichment

Buyers can take delivery as-is or with enrichment (de-identification, transcription and translation,
labeling, dedup and quality scoring, schema normalization, metadata and embeddings). Orders live in
`enrichment_orders` (`supabase/migrations/20261108000004_enrichment.sql`). Price is cost plus a markup
that is never below 12% (default 15%), enforced by a check constraint and a trigger that reads
`app_settings.enrichment_min_markup_bps`. Buyers read `enrichment_orders_buyer`, which shows the
quoted price only, never cost or markup. Pricing helper: `src/lib/enrichment/pricing.ts`.

## Clickable prototype

`prototype/index.html` is the full clickable prototype (single file, no build). Open it in a browser,
or it's served at `/prototype/` if you copy it into `public/`. Use the "View as" switcher at the bottom
right to see the site as a visitor, data owner, buyer or partner. Its data is example data only.

## Deploy

1. Create a GitHub repo and push this folder (`git push -u origin main`).
2. In Supabase: create a project, run the migrations in `supabase/migrations` in order, and set the
   global upload limit to match the `samples` bucket if you're on a paid plan.
3. In Vercel: import the repo, add the variables from `.env.example`, and deploy. Crons in
   `vercel.json` run partner payouts (1st and 15th) and sample expiry (hourly).
4. In Stripe: enable Connect, add the webhook endpoint `/api/webhooks/stripe`.

## Setup

1. **Supabase**: create a project, then `supabase link` and `supabase db push` (applies `supabase/migrations`).
   - Auth → Email: enable magic links. Set Site URL to your domain and add `https://YOUR-DOMAIN/auth/callback` to redirect URLs.
   - Make yourself admin: `update profiles set is_admin = true where email = 'you@company.com';`
2. **Stripe**: enable Connect (Express). Add a webhook to `https://YOUR-DOMAIN/api/webhooks/stripe` listening for `payment_intent.succeeded`, `charge.refunded`, `account.updated`, with "Listen to events on Connected accounts" on as well.
3. **Env**: copy `.env.example` to `.env.local` and fill it in. Add the same vars in Vercel.
4. **Run**: `npm install && npm run dev`.
5. **Deploy**: push to GitHub, import in Vercel. `vercel.json` registers the payout cron; set `CRON_SECRET` in Vercel.

## Tests

- `npm run test` — referral helper unit tests (code validation, redirect safety, fee math, cookie parsing).
- `npm run test:db` — spins up a throwaway Postgres, applies migrations on a Supabase auth stub, and runs `supabase/tests/referrals.test.sql` (attribution, domain inheritance, self-referral, commissions, refunds, expiry, payouts, RLS). Needs local Postgres binaries; run as a non-root user.

## Next build steps
- Port the prototype's marketing pages, marketplace, listing detail, NDA flow, sell assistant, data wanted and talent network.
- Deal offer flow that creates the Stripe PaymentIntent (`metadata.deal_id`) for escrow.
- Legal pages, cookie consent, contact form, journal.
- `npm run db:types` once linked, to replace untyped Supabase calls with generated types.
