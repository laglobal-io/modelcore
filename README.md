# ModelCore

Marketplace for proprietary AI training data, with a talent network and a referral partner program.
Next.js (App Router) + Supabase (Postgres, Auth, RLS) + Stripe Connect, deployed on Vercel.

**Status:** referral system complete end to end (database, tracking, attribution, commissions, payouts, partner and admin dashboards) plus magic-link onboarding. Marketplace pages from the prototype are the next build step.

## Referral system

| Step | Where | What happens |
|---|---|---|
| Partner claims a code | `/partners/dashboard` → `become_partner()` | Code like `levay`, link `modelcore.io/r/levay` |
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
