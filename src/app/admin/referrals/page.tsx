import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { formatUsd } from "@/lib/referrals/core";
import { ManualAttributionForm } from "./client";

export const metadata: Metadata = { title: "Referrals admin", robots: { index: false } };
export const dynamic = "force-dynamic";

type Overview = {
  totals: { partners: number; clicks_30d: number; attributions: number; owed_cents: number; paid_cents: number };
  partners: { id: string; code: string; type: string; status: string; payouts_enabled: boolean; name: string; email: string; company: string | null; clicks: number; signups: number; deals: number; earned_cents: number; owed_cents: number }[];
  recent_attributions: { id: string; partner_code: string; company: string; role: string; source: string; attributed_at: string; expires_at: string }[];
};
const date = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default async function AdminReferrals() {
  const { supabase, user } = await getUser();
  if (!user) redirect("/join?mode=login&next=/admin/referrals");
  const { data, error } = await supabase.rpc("admin_referral_overview");
  if (error || !data) notFound(); // non-admins get a 404, not a hint the page exists
  const o = data as Overview;

  return (
    <>
      <section className="pagehead"><div className="wrap">
        <span className="eyebrow">Admin</span>
        <h1 className="d d-m">Referrals</h1>
      </div></section>
      <section className="section"><div className="wrap stack">
        <div className="stats">
          <div className="stat"><span className="mono muted">Partners</span><b>{o.totals.partners}</b></div>
          <div className="stat"><span className="mono muted">Clicks, 30 days</span><b>{o.totals.clicks_30d}</b></div>
          <div className="stat"><span className="mono muted">Attributed members</span><b>{o.totals.attributions}</b></div>
          <div className="stat"><span className="mono muted">Owed to partners</span><b className="acc">{formatUsd(o.totals.owed_cents)}</b></div>
          <div className="stat"><span className="mono muted">Paid to partners</span><b>{formatUsd(o.totals.paid_cents)}</b></div>
        </div>

        <div className="panel">
          <h2>Partners</h2>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Code</th><th>Partner</th><th>Type</th><th>Status</th><th>Payouts</th><th className="num">Clicks</th><th className="num">Signups</th><th className="num">Deals</th><th className="num">Earned</th><th className="num">Owed</th></tr></thead>
            <tbody>{o.partners.map((p) => (
              <tr key={p.id}>
                <td><b>{p.code}</b></td>
                <td>{p.name || p.email}<div className="muted" style={{ fontSize: 12 }}>{p.company ?? p.email}</div></td>
                <td>{p.type.replace("_", " ")}</td>
                <td><span className={`chip ${p.status === "active" ? "ok" : "warn"}`}>{p.status}</span></td>
                <td>{p.payouts_enabled ? <span className="chip ok">On</span> : <span className="chip">Not set up</span>}</td>
                <td className="num">{p.clicks}</td><td className="num">{p.signups}</td><td className="num">{p.deals}</td>
                <td className="num">{formatUsd(p.earned_cents)}</td><td className="num">{formatUsd(p.owed_cents)}</td>
              </tr>))}
            </tbody>
          </table></div>
        </div>

        <div className="grid2">
          <div className="panel">
            <h2>Recent attributions</h2>
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Member</th><th>Partner</th><th>Source</th><th>Joined</th><th>Expires</th></tr></thead>
              <tbody>{o.recent_attributions.map((a) => (
                <tr key={a.id}><td>{a.company}<div className="muted" style={{ fontSize: 12 }}>{a.role}</div></td><td>{a.partner_code}</td>
                  <td><span className="chip">{a.source}</span></td><td>{date(a.attributed_at)}</td><td>{date(a.expires_at)}</td></tr>))}
              </tbody>
            </table></div>
          </div>
          <div className="panel">
            <h2>Credit a partner manually</h2>
            <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>For offline intros or a missed link. Only works if the member has no attribution yet.</p>
            <ManualAttributionForm />
          </div>
        </div>
      </div></section>
    </>
  );
}
