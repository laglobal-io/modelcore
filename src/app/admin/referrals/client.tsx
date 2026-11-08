"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ManualAttributionForm() {
  const router = useRouter();
  const [f, setF] = useState({ email: "", partnerCode: "", note: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const r = await fetch("/api/admin/attributions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
        const j = await r.json().catch(() => ({}));
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: j.error ?? "Couldn't save." });
        setMsg({ ok: true, text: `Credited ${f.email} to ${f.partnerCode}.` });
        setF({ email: "", partnerCode: "", note: "" });
        router.refresh();
      }}
    >
      <label className="f" htmlFor="aEmail">Member email<input id="aEmail" className="field" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="jordan@company.com" /></label>
      <label className="f" htmlFor="aCode">Partner code<input id="aCode" className="field" value={f.partnerCode} onChange={(e) => setF({ ...f, partnerCode: e.target.value })} placeholder="levay" /></label>
      <label className="f" htmlFor="aNote">Note<input id="aNote" className="field" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Intro at conference" /></label>
      {msg && <p className={msg.ok ? "okmsg" : "err"} role="status">{msg.text}</p>}
      <div><button className="btn sm" aria-busy={busy}>Credit partner</button></div>
    </form>
  );
}
