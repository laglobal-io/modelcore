"use client";

import { useState } from "react";

type Role = "seller" | "buyer";
type Step = { key: "industry" | "data" | "volume" | "contact"; tab: string; q: string; h: string; many?: boolean; list?: boolean; opts?: [string, string?][] };

const DATA: [string, string][] = [
  ["Conversational", "Chat logs, support tickets, Q&A threads"],
  ["Tabular records", "CSV, SQL dumps, spreadsheets, databases"],
  ["Image sets", "Photos, scans, satellite imagery"],
  ["Audio and speech", "Call recordings, broadcasts, podcasts"],
  ["Document corpus", "PDFs, contracts, filings, reports"],
  ["Code repos", "Source code, commit history, design docs"],
  ["Video", "Bodycam, egocentric, instructional footage"],
  ["Business operations", "Slack, CRM, Jira, email, internal wikis"],
  ["Medical records", "EHR, clinical notes, DICOM"],
  ["Transaction logs", "Payments, orders, financial activity"],
  ["Geospatial", "GPS, mobility, mapping"],
  ["Sensor and IoT", "Telemetry, industrial sensors, robotics logs"],
  ["Other", "Something else. We'll help describe it"],
];

const FLOWS: Record<Role, Step[]> = {
  seller: [
    { key: "industry", tab: "Industry", q: "What space are you in?", h: "Industry", opts: ["Healthcare and pharma", "Financial services", "Insurance", "Retail and e-commerce", "Media and publishing", "Audio and broadcast", "Gaming", "Legal", "Geospatial and mobility", "Software and SaaS", "Industrial and energy", "Other"].map((x) => [x]) },
    { key: "data", tab: "Data", q: "What do you have?", h: "Data", many: true, opts: DATA },
    { key: "volume", tab: "Volume", q: "How much?", h: "Volume", list: true, opts: [["Under 10K records"], ["10K-100K records"], ["100K-1M records"], ["1M-10M records"], ["10M-100M records"], ["100M+ records"], ["Measured in hours", "Audio or video archives"], ["Not sure", "We'll help you size it"]] },
    { key: "contact", tab: "Contact", q: "How do we reach you?", h: "Contact" },
  ],
  buyer: [
    { key: "industry", tab: "Team", q: "What are you building?", h: "Your team", opts: [["Frontier model lab"], ["Vertical AI product"], ["Robotics and embodied AI"], ["Coding agents"], ["Speech and voice"], ["Enterprise in-house AI"], ["Data vendor or reseller"], ["Other"]] },
    { key: "data", tab: "Data", q: "What do you need?", h: "Data", many: true, opts: DATA },
    { key: "volume", tab: "Budget", q: "Budget per dataset?", h: "Budget", list: true, opts: [["Under $50k"], ["$50k-$250k"], ["$250k-$1M"], ["$1M+"], ["Not set yet", "We'll help you scope it"]] },
    { key: "contact", tab: "Contact", q: "How do we reach you?", h: "Contact" },
  ],
};

export default function Onboarding(props: {
  initialRole: Role | null;
  next: string | null;
  linkExpired: boolean;
  startInLogin: boolean;
  referredBy: string | null;
}) {
  const [role, setRole] = useState<Role | null>(props.initialRole);
  const [login, setLogin] = useState(props.startInLogin);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<{ industry?: string; data: string[]; volume?: string }>({ data: [] });
  const [c, setC] = useState({ name: "", company: "", email: "", website: "", phone: "", source: "", referralCode: "", authorized: false, terms: false });
  const [err, setErr] = useState<string | null>(props.linkExpired ? "That sign-in link expired or was already used. Request a new one." : null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Something went wrong. Try again.");
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="wrap ob-body" style={{ maxWidth: 760, marginLeft: 0 }}>
        <span className="ob-q">Almost there</span>
        <h1 className="d d-l">Check your<br /><span className="acc">inbox.</span></h1>
        <p className="lede" style={{ marginTop: 20 }}>We sent a sign-in link to <b style={{ color: "var(--fg)" }}>{sentTo}</b>. It works once and expires in 15 minutes. No password needed.</p>
        <p style={{ display: "flex", gap: 18, marginTop: 22 }}>
          <button className="link" onClick={() => setSentTo(null)}>Use a different email</button>
        </p>
      </div>
    );
  }

  if (login) {
    return (
      <div className="wrap ob-body">
        <span className="ob-q">Welcome back</span>
        <h1 className="d d-l">Log in</h1>
        <form className="form" style={{ maxWidth: 480, marginTop: 32 }} noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (!/^\S+@\S+\.\S+$/.test(c.email)) return setErr("Enter a valid email.");
          if (await post("/api/auth/login", { email: c.email, next: props.next })) setSentTo(c.email);
        }}>
          <label className="f" htmlFor="lEmail">Work email<input id="lEmail" className="field" type="email" autoComplete="email" placeholder="jordan@company.com" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></label>
          {err && <p className="err">{err}</p>}
          <div><button className="btn" aria-busy={busy}>Email me a sign-in link</button></div>
          <p className="muted" style={{ fontSize: 14 }}>New here? <button type="button" className="link" onClick={() => { setLogin(false); setErr(null); }}>Get started</button></p>
        </form>
      </div>
    );
  }

  if (!role) {
    return (
      <div className="wrap ob-body">
        <span className="ob-q">Get started</span>
        <h1 className="d d-l">Which side<br />are you on?</h1>
        <span className="free">Free to join. Free to list. Free to browse</span>
        {props.referredBy && <p className="muted" style={{ marginTop: 12 }}>Referral applied: <span className="chip acc">{props.referredBy}</span></p>}
        {err && <p className="err" style={{ marginTop: 16 }}>{err}</p>}
        <div className="roles">
          <button className="role" onClick={() => setRole("buyer")}><b>I&apos;m buying data</b><span className="muted">Browse the catalog, post requests, make offers</span></button>
          <button className="role" onClick={() => setRole("seller")}><b>I have data to license</b><span className="muted">List datasets and answer buyer requests</span></button>
        </div>
        <p className="muted" style={{ marginTop: 24, fontSize: 14 }}>Already a member? <button className="link" onClick={() => { setLogin(true); setErr(null); }}>Log in</button></p>
      </div>
    );
  }

  const flow = FLOWS[role];
  const st = flow[step];
  const selected = (v: string) => (st.many ? answers.data.includes(v) : answers[st.key as "industry" | "volume"] === v);

  function pick(v: string) {
    setErr(null);
    if (st.many) {
      setAnswers((a) => ({ ...a, data: a.data.includes(v) ? a.data.filter((x) => x !== v) : [...a.data, v] }));
    } else {
      setAnswers((a) => ({ ...a, [st.key]: v }));
      setTimeout(() => setStep((s) => (s === step ? s + 1 : s)), 280);
    }
  }

  async function next() {
    if (st.key === "industry" && !answers.industry) return setErr("Pick one to continue.");
    if (st.key === "data" && !answers.data.length) return setErr("Select at least one.");
    if (st.key === "volume" && !answers.volume) return setErr("Pick one to continue.");
    if (st.key !== "contact") { setErr(null); setStep(step + 1); window.scrollTo(0, 0); return; }
    if (!c.name.trim() || !c.company.trim() || !c.website.trim()) return setErr("Fill in every field marked *.");
    if (!/^\S+@\S+\.\S+$/.test(c.email)) return setErr("Enter a valid work email.");
    if (role === "seller" && !c.authorized) return setErr("Confirm you're authorized to license the data.");
    if (!c.terms) return setErr("Tick the consent box to continue.");
    const ok = await post("/api/onboarding", {
      role, next: props.next,
      answers: { industry: answers.industry, data: answers.data, volume: answers.volume },
      contact: { name: c.name, company: c.company, email: c.email, website: c.website, phone: c.phone, source: c.source, referralCode: c.referralCode },
      consents: { terms: c.terms, authorized: c.authorized },
    });
    if (ok) { setSentTo(c.email); window.scrollTo(0, 0); }
  }

  return (
    <>
      <div className="wrap">
        <div className="ob-prog">
          {flow.map((s, i) => <span key={s.key} className={i === step ? "on" : ""}><em>0{i + 1}</em>{s.tab}</span>)}
          <i style={{ width: `${((step + 1) / flow.length) * 100}%` }} />
        </div>
      </div>
      <div className="wrap ob-body" key={`${role}-${step}`}>
        <span className="ob-q">{st.q}</span>
        <h1 className="d d-l">{st.h}</h1>
        {(step === 0 || st.key === "contact") && <span className="free">Free to join. {role === "seller" ? "No listing fees" : "Free to browse"}</span>}
        {st.key !== "contact" ? (
          <>
            <div className={`tiles${st.list ? " list" : ""}`} role={st.many ? "group" : "radiogroup"} aria-label={st.h}>
              {st.opts!.map(([v, sub]) => (
                <button key={v} type="button" className={`tile${st.many ? "" : " radio"}`} role={st.many ? "checkbox" : "radio"} aria-checked={selected(v)} onClick={() => pick(v)}>
                  <b>{v}</b>{sub && <small>{sub}</small>}
                </button>
              ))}
            </div>
            {st.many && <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>Select all that apply</p>}
          </>
        ) : (
          <form className="panel form" style={{ marginTop: 36, maxWidth: 880 }} noValidate onSubmit={(e) => { e.preventDefault(); next(); }}>
            <div className="two">
              <label className="f" htmlFor="oName">Full name *<input id="oName" className="field" autoComplete="name" placeholder="Jordan Ellis" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
              <label className="f" htmlFor="oCo">Company *<input id="oCo" className="field" autoComplete="organization" placeholder="Harbor Mutual" value={c.company} onChange={(e) => setC({ ...c, company: e.target.value })} /></label>
            </div>
            <div className="two">
              <label className="f" htmlFor="oEmail">Work email *<input id="oEmail" className="field" type="email" autoComplete="email" placeholder="jordan@company.com" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></label>
              <label className="f" htmlFor="oSite">Company website *<input id="oSite" className="field" autoComplete="url" placeholder="company.com" value={c.website} onChange={(e) => setC({ ...c, website: e.target.value })} /></label>
            </div>
            <div className="two">
              <label className="f" htmlFor="oPhone">Phone<input id="oPhone" className="field" type="tel" autoComplete="tel" placeholder="(555) 000-0000" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></label>
              <label className="f" htmlFor="oSrc">How did you find ModelCore?
                <select id="oSrc" className="field" value={c.source} onChange={(e) => setC({ ...c, source: e.target.value })}>
                  <option value="">Select one</option>
                  {["Search engine", "AI assistant", "Referred by a partner", "LinkedIn", "Event or conference", "Other"].map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            </div>
            {c.source === "Referred by a partner" && !props.referredBy && (
              <label className="f" htmlFor="oRef">Referral code<input id="oRef" className="field" placeholder="levay" value={c.referralCode} onChange={(e) => setC({ ...c, referralCode: e.target.value })} /></label>
            )}
            {props.referredBy && <p className="muted" style={{ fontSize: 14, margin: 0 }}>Referral applied: <span className="chip acc">{props.referredBy}</span></p>}
            {role === "seller" && (
              <label className="check"><input type="checkbox" checked={c.authorized} onChange={(e) => setC({ ...c, authorized: e.target.checked })} /> I&apos;m authorized to license this data on my company&apos;s behalf.</label>
            )}
            <label className="check"><input type="checkbox" checked={c.terms} onChange={(e) => setC({ ...c, terms: e.target.checked })} /> I agree to the Terms and Privacy Policy, and to ModelCore contacting me by email or phone about {role === "seller" ? "licensing my data" : "the data I'm looking for"}. A masked summary may be shown to verified {role === "seller" ? "buyers" : "data owners"}.</label>
            <button type="submit" hidden />
          </form>
        )}
      </div>
      <div className="ob-foot">
        <div className="wrap">
          <button className="link" onClick={() => { setErr(null); step === 0 ? setRole(null) : setStep(step - 1); }}>← Back</button>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn" aria-busy={busy} onClick={next}>{st.key === "contact" ? "Email me a sign-in link" : "Continue"}</button>
        </div>
      </div>
    </>
  );
}
