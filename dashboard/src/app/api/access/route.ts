import { NextRequest, NextResponse } from "next/server";
import {
  deriveAccessToken,
  getAccessCode,
  getAccessCookieName,
  getAccessCookieTtlSeconds,
  isSecureAccessCookieEnabled,
  isAccessGateEnabled,
} from "@/lib/access-gate";

export async function POST(request: NextRequest) {
  if (!isAccessGateEnabled()) {
    return NextResponse.json({ ok: true, disabled: true });
  }

  let code = "";
  try {
    const body = (await request.json()) as { code?: string };
    code = String(body?.code || "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const expectedCode = getAccessCode();
  if (!code || !expectedCode || code !== expectedCode) {
    return NextResponse.json({ ok: false, error: "Invalid access code." }, { status: 401 });
  }

  const token = await deriveAccessToken(code);
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: getAccessCookieName(),
    value: token,
    httpOnly: true,
    secure: isSecureAccessCookieEnabled(),
    sameSite: "lax",
    path: "/",
    maxAge: getAccessCookieTtlSeconds(),
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: getAccessCookieName(),
    value: "",
    path: "/",
    maxAge: 0,
  });
  return response;
}
