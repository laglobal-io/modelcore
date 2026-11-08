import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { formatUsd, suggestCode } from "@/lib/referrals/core";
import { BecomePartnerForm, ConnectPayoutsButton, ReferralLinks } from "./client";

export const metadata: Metadata = { title: "Partner dashboard", robots: { index: false } };
export const dynamic = "force-dynamic";

type Dashboard = {
  partner: { code: string; short_code: string; type: string; status: string; share_bps: number; platform_fee_bps: number; payouts_enabled: boolean; attribution_window_months: number; min_payout_cents: number };
  stats: { clicks_30d: number; clicks_total: number; visitors_total: number; signups: number; active_referrals: number; deals_closed: number; pending_cents: number; approved_cents: number; paid_cents: number };
  clicks_by_day: { day: string; clicks: number }[];
  pipeline: { attribution_id: string; company: string; role: string; source: string; attributed_at: string; expires_at: string; stage: string; listings_count: number; deals_closed: number; gross_cents: number; commission_cents: number }[];
  commissions: { id: string; side: string; status: string; company: string; deal_amount_cents: number; commission_cents: number; created_at: string; paid_at: string | null }[];
  payouts: { id: string; amount_cents: number; status: string; created_at: string; paid_at: string | null }[];
};

const STAGES: Record<string, { label: string; cls: string }> = {
  signed_up: { label: "Signed up", cls: "" },
  active: { label: "Listed or requesting", cls: "acc" },
  nda_signed: { label: "NDA signed", cls: "acc" },
  in_escrow: { label: "In escrow", cls: "warn" },
  deal_closed: { label: "Deal closed", cls: "ok" },
};
const STATUS: Record<string, string> = { pending: "warn", approved: "acc", paid: "ok", void: "bad", processing: "warn", failed: "bad" };
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

export default async function PartnerDashboard({ searchParams }: { searchParams: Promise<{ stripe?: string }> }) {
  const { supabase, user } = await getUser();
  if (!user) redirect("/join?next=/partners/dashboard");
  const sp = await searchParams;

  const { data, error } = await supabase.rpc("partner_dashboard");
  if (error) throw new Error(error.message);

  if (!data) {
    const { data: me } = await supabase.from("profiles").select("full_name").eq("id", user.id).single();
    return (
      <>
        <section className="pagehead"><div className="wrap">
          <span className="eyebrow">Partner program</span>
          <h1 className="d d-l">Bring deals.<br /><span className="acc">Keep 25%.</span></h1>
          <p className="lede">Refer data owners or buyers. When a referred company closes a deal, you earn 25% of ModelCore&apos;s 10% fee, 2.5% of the deal value, for 24 months from their first visit. No cap.</p>
        </div></section>
        <section className="section"><div className="wrap" style={{ maxWidth: 640, marginLeft: 0 }}>
          <div className="panel"><h2>Claim your referral code</h2><BecomePartnerForm suggested={suggestCode(me?.full_name || user.email?.split("@")[0] || "partner")} /></div>
        </div></section>
      </>
    );
  }

  const d = data as Dashboard;
  const host = env.siteUrl().replace(/^https?:\/\//, "");
  const named = `${host}/r/${d.partner.code}`, coded = `${host}/r/${d.partner.short_code}`;
  const effective = ((d.partner.platform_fee_bps * d.partner.share_bps) / 1e8) * 100;

  // 30-day click series with empty days filled
  const byDay = new Map(d.clicks_by_day.map((r) => [r.day, r.clicks]));
  const days = Array.from({ length: 30 }, (_, i) => {
    const t = new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10);
    return { day: t, clicks: byDay.get(t) ?? 0 };
  });
  const peak = Math.max(1, ...days.map((x) => x.clicks));

  const funnel = [
    ["Visitors", d.stats.visitors_total],
    ["Signed up", d.stats.signups],
    ["Active", d.pipeline.filter((p) => p.stage !== "signed_up").length],
    ["NDA or escrow", d.pipeline.filter((p) => ["nda_signed", "in_escrow", "deal_closed"].includes(p.stage)).length],
    ["Deals closed", d.stats.deals_closed],
  ] as const;

  return (
    <>
      <section className="pagehead"><div className="wrap">
        <span className="eyebrow">Partner dashboard</span>
        <h1 className="d d-m">{d.partner.code}</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          You earn {d.partner.share_bps / 100}% of ModelCore&apos;s {d.partner.platform_fee_bps / 100}% fee ({effective.toFixed(1)}% of deal value, no cap) for {d.partner.attribution_window_months} months from each referral&apos;s first visit.
        </p>
      </div></section>

      <section className="section"><div className="wrap stack">
        {sp.stripe === "done" && !d.partner.payouts_enabled && <p className="okmsg">Thanks. Stripe is reviewing your details; payouts turn on automatically once approved.</p>}

        <div className="stats">
          <div className="stat"><span className="mono muted">Clicks, 30 days</span><b>{d.stats.clicks_30d}</b><small>{d.stats.clicks_total} all time</small></div>
          <div className="stat"><span className="mono muted">Referred companies</span><b>{d.stats.signups}</b><small>{d.stats.active_referrals} in window</small></div>
          <div className="stat"><span className="mono muted">Deals closed</span><b>{d.stats.deals_closed}</b></div>
          <div className="stat"><span className="mono muted">Owed to you</span><b className="acc">{formatUsd(d.stats.approved_cents + d.stats.pending_cents)}</b><small>Paid on the 1st and 15th</small></div>
          <div className="stat"><span className="mono muted">Paid out</span><b>{formatUsd(d.stats.paid_cents)}</b></div>
        </div>

        <div className="grid2">
          <div className="stack">
            <div className="panel">
              <h2>Funnel</h2>
              <div className="funnel">{funnel.map(([l, n]) => <div key={l}><span className="mono muted">{l}</span><b>{n}</b></div>)}</div>
            </div>
            <div className="panel">
              <h2>Clicks, last 30 days</h2>
              <div className="bars" role="img" aria-label={`Referral clicks per day, peak ${peak}`}>
                {days.map((x) => <span key={x.day} title={`${x.day}: ${x.clicks}`} style={{ height: `${(x.clicks / peak) * 100}%` }} />)}
              </div>
              <div className="bars-axis mono muted"><span>{date(days[0].day)}</span><span>Today</span></div>
            </div>
          </div>
          <div className="stack">
            <div className="panel">
              <h2>Your referral link</h2>
              <ReferralLinks named={named} coded={coded} />
              <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Add <code>?to=/join?role=seller</code> to send data owners straight to onboarding. Colleagues who join from the same company domain are credited to you too.</p>
            </div>
            <div className="panel">
              <h2>Payouts</h2>
              {d.partner.payouts_enabled
                ? <p style={{ margin: 0 }}><span className="chip ok">Payouts on</span> <span className="muted" style={{ fontSize: 14 }}>Minimum {formatUsd(d.partner.min_payout_cents)} per transfer.</span></p>
                : <><p className="muted" style={{ marginTop: 0, fontSize: 14 }}>Connect a bank account through Stripe to get paid. Commissions keep accruing until you do.</p><ConnectPayoutsButton /></>}
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>Referred companies</h2>
          {d.pipeline.length === 0 ? <p className="empty">No referrals yet. Share your link with a company sitting on data, or a team looking to buy it.</p> : (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Company</th><th>Side</th><th>Stage</th><th>Joined</th><th>Window ends</th><th className="num">Deals</th><th className="num">Deal volume</th><th className="num">You earned</th></tr></thead>
              <tbody>{d.pipeline.map((p) => (
                <tr key={p.attribution_id}>
                  <td>{p.company}{p.source === "domain" && <span className="muted" style={{ fontSize: 12 }}> · via colleague</span>}</td>
                  <td>{p.role === "buyer" ? "Buyer" : "Data owner"}</td>
                  <td><span className={`chip ${STAGES[p.stage]?.cls ?? ""}`}>{STAGES[p.stage]?.label ?? p.stage}</span></td>
                  <td>{date(p.attributed_at)}</td>
                  <td>{date(p.expires_at)}</td>
                  <td className="num">{p.deals_closed}</td>
                  <td className="num">{formatUsd(p.gross_cents)}</td>
                  <td className="num">{formatUsd(p.commission_cents)}</td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </div>

        <div className="grid2">
          <div className="panel">
            <h2>Commissions</h2>
            {d.commissions.length === 0 ? <p className="empty">Commissions appear here when a referred company&apos;s deal releases from escrow.</p> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>Company</th><th>Side</th><th>Status</th><th>Date</th><th className="num">Deal</th><th className="num">Commission</th></tr></thead>
                <tbody>{d.commissions.map((c) => (
                  <tr key={c.id}><td>{c.company}</td><td>{c.side === "buyer" ? "Buyer" : "Seller"}</td>
                    <td><span className={`chip ${STATUS[c.status] ?? ""}`}>{c.status}</span></td>
                    <td>{date(c.created_at)}</td><td className="num">{formatUsd(c.deal_amount_cents)}</td><td className="num">{formatUsd(c.commission_cents)}</td></tr>))}
                </tbody>
              </table></div>
            )}
          </div>
          <div className="panel">
            <h2>Transfers</h2>
            {d.payouts.length === 0 ? <p className="empty">No transfers yet.</p> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>Date</th><th>Status</th><th className="num">Amount</th></tr></thead>
                <tbody>{d.payouts.map((p) => (
                  <tr key={p.id}><td>{date(p.paid_at ?? p.created_at)}</td><td><span className={`chip ${STATUS[p.status] ?? ""}`}>{p.status}</span></td><td className="num">{formatUsd(p.amount_cents)}</td></tr>))}
                </tbody>
              </table></div>
            )}
          </div>
        </div>
      </div></section>
    </>
  );
}
