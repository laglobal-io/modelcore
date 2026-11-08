import type { Metadata } from "next";
import Link from "next/link";
import { Archivo, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--f-display", display: "swap" });
const body = Instrument_Sans({ subsets: ["latin"], variable: "--f-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--f-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "ModelCore | AI training data marketplace", template: "%s | ModelCore" },
  description: "List proprietary datasets for free, answer buyer requests and license directly to AI teams. Masked until NDA, paid through escrow.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <header className="top">
          <div className="wrap">
            <Link href="/" className="logo" aria-label="ModelCore home"><i />modelcore</Link>
            <nav>
              <Link href="/market">Marketplace</Link>
              <Link href="/partners/dashboard">Partners</Link>
              <Link href="/join" className="btn sm">Get started</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
