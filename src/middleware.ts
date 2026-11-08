import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { normalizeCode } from "@/lib/referrals/core";

// Members-only areas. Visitors are sent to onboarding and returned afterwards.
const PROTECTED = ["/market", "/listings", "/partners/dashboard", "/admin", "/account"];

export async function middleware(req: NextRequest) {
  const url = req.nextUrl;

  // Any page with ?ref=code goes through the tracked referral route.
  const ref = normalizeCode(url.searchParams.get("ref"));
  if (ref && !url.pathname.startsWith("/r/")) {
    const clean = new URL(url);
    clean.searchParams.delete("ref");
    const to = clean.pathname + clean.search;
    return NextResponse.redirect(new URL(`/r/${ref}?to=${encodeURIComponent(to)}`, url.origin));
  }

  // Refresh the Supabase session cookie on every request.
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();

  if (!data.user && PROTECTED.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) {
    const to = new URL("/join", url.origin);
    to.searchParams.set("next", url.pathname + url.search);
    return NextResponse.redirect(to);
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/cron|.*\\.(?:png|jpg|svg|ico|webp|txt|xml)$).*)"],
};
