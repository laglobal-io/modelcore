import Link from "next/link";

// Placeholder home. The full marketing site from the prototype is ported in the next build step.
export default function Home() {
  return (
    <section className="pagehead">
      <div className="wrap">
        <span className="eyebrow">The marketplace for AI training data</span>
        <h1 className="d d-l">Your data<br />has <span className="acc">buyers.</span></h1>
        <p className="lede">Free to join, free to list, free to browse. ModelCore earns 10% only when a deal closes through escrow.</p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
          <Link className="btn" href="/join?role=seller">List your data</Link>
          <Link className="btn ghost" href="/join?role=buyer">I&apos;m buying data</Link>
        </div>
      </div>
    </section>
  );
}
