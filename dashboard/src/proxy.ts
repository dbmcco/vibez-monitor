import { NextRequest, NextResponse } from "next/server";
import {
  getAccessCookieName,
  isAccessGateEnabled,
  isValidAccessToken,
} from "@/lib/access-gate";

function isPublicPath(pathname: string): boolean {
  if (pathname === "/access") return true;
  if (pathname === "/api/access") return true;
  if (pathname === "/api/health") return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname.startsWith("/icons/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/favicon.png") return true;
  if (pathname.match(/\.(?:png|jpg|jpeg|svg|ico|gif|webp|css|js|map|woff2?)$/i)) return true;
  return false;
}

export async function proxy(request: NextRequest) {
  if (!isAccessGateEnabled()) {
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(getAccessCookieName())?.value;
  if (await isValidAccessToken(token)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: "Access code required.",
      },
      { status: 401 },
    );
  }

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/access";
  redirectUrl.search = `next=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(redirectUrl);
}

export const config = {
  matcher: ["/:path*"],
};
