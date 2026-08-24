import { NextResponse, type NextRequest } from "next/server";
import { refreshSession } from "@/data-access/supabase-middleware";

// Routes reachable without a session. Everything else redirects to /login.
const PUBLIC_ROUTES = ["/login", "/signup", "/api/health"];

// Next.js 16 renamed the "middleware" file convention to "proxy" (same
// runtime, same config shape, function just needs to be named/exported
// differently) — see node_modules/next/dist/docs/.../file-conventions/proxy.md.
export async function proxy(request: NextRequest) {
  const { response, user } = await refreshSession(request);

  const { pathname } = request.nextUrl;
  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));

  if (!user && !isPublicRoute) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user && isPublicRoute) {
    // Already signed in — no reason to see the login/signup forms again.
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    // Every route except static assets, images, and favicon.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
