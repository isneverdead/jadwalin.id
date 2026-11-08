import { AppError } from "@jadwalin/core";
import { downloadClientAttachment } from "@jadwalin/module-tickets";
import { NextResponse } from "next/server";
import { currentUser, getPool, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Klien hanya bisa mengunduh lampiran terlihat pada tiketnya sendiri; lalu dialihkan ke URL ber-tanda-tangan 60 detik. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; number: string; id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/masuk", request.url));
  const { slug, number, id } = await params;
  try {
    const { url } = await downloadClientAttachment(getPool(), user.id, slug, getStorage(), Number(number), id);
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    if (error instanceof AppError && (error.code === "not_found" || error.code === "forbidden")) return new NextResponse("Lampiran tidak ditemukan.", { status: 404 });
    throw error;
  }
}
