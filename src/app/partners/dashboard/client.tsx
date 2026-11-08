"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CopyLink({ text }: { text: string }) {
  const [label, setLabel] = useState("Copy");
  return (
    <div className="copy">
      <code id="refLink">{text}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`https://${text}`);
            setLabel("Copied");
          } catch {
            const r = document.createRange();
            r.selectNodeContents(document.getElementById("refLink")!);
            const s = getSelection();
            s?.removeAllRanges();
            s?.addRange(r);
            setLabel("Selected");
          }
          setTimeout(() => setLabel("Copy"), 1800);
        }}
      >
        {label}
      </button>
    </div>
  );
}

export function BecomePartnerForm({ suggested }: { suggested: string }) {
  const router = useRouter();
  const [code, setCode] = useState(suggested);
  const [type, setType] = useState("sell_side");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await fetch("/api/partners", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, type }) });
        const j = await r.json().catch(() => ({}));
        setBusy(false);
        if (!r.ok) return setErr(j.error ?? "Couldn't claim that code. Try another.");
        router.refresh();
      }}
    >
      <label className="f" htmlFor="pCode">Referral code
        <input id="pCode" className="field" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} maxLength={32} />
      </label>
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Your link will be modelcore.io/r/{code || "your-code"}</p>
      <label className="f" htmlFor="pType">Who will you refer?
        <select id="pType" className="field" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="sell_side">Data owners (I advise or invest in companies)</option>
          <option value="buy_side">Buyers (AI teams, labs, data vendors)</option>
          <option value="talent">Experts for the talent network</option>
          <option value="general">A mix</option>
        </select>
      </label>
      {err && <p className="err" role="alert">{err}</p>}
      <div><button className="btn" aria-busy={busy}>Claim code</button></div>
    </form>
  );
}

export function ConnectPayoutsButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn sm"
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          const r = await fetch("/api/partners/stripe-connect", { method: "POST" });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.url) window.location.href = j.url;
          else { setBusy(false); setErr(j.error ?? "Couldn't reach Stripe. Try again."); }
        }}
      >
        Set up payouts
      </button>
      {err && <p className="err" role="alert" style={{ marginTop: 10 }}>{err}</p>}
    </>
  );
}
