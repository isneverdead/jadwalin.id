import { AppError, getProofDownloadUrl } from "@jadwalin/core";
import { NextResponse } from "next/server";
import { currentUser, getPool, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Bukti pembayaran hanya untuk staf workspace: otorisasi dulu, lalu alihkan ke URL bertanda tangan berumur pendek. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/masuk", request.url));
  const { slug, id } = await params;
  try {
    const { url } = await getProofDownloadUrl(getPool(), { userId: user.id, slug }, getStorage(), id);
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    if (error instanceof AppError && (error.code === "not_found" || error.code === "forbidden")) return new NextResponse("Bukti tidak ditemukan.", { status: 404 });
    throw error;
  }
}
