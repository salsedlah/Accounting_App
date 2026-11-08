import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/health",
  "/manifest.webmanifest",
  "/sw.js",
  "/offline",
  "/icons",
  "/fonts",
  "/favicon.ico",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get("hisab_session")?.value;
  const hasBearerToken = /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "");

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (!token && !(pathname.startsWith("/api/") && hasBearerToken)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "يجب تسجيل الدخول", code: "unauthorized" }, { status: 401 });
    }
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
