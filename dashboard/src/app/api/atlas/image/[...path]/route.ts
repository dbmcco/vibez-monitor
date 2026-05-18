import { NextResponse } from "next/server";

import { readAtlasGeneratedAsset } from "@/lib/atlas-artifact";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path: string[] }> | { path: string[] };
};

async function resolveMaybe<T>(value: Promise<T> | T): Promise<T> {
  return value;
}

export async function GET(_request: Request, context: RouteContext) {
  const params = await resolveMaybe(context.params);
  const relativePath = params.path.join("/");
  const asset = readAtlasGeneratedAsset(relativePath);
  if (!asset) {
    return NextResponse.json({ error: "atlas image unavailable" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(asset.data), {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
