import { getProductImageUrl } from "@jadwalin/module-rental";
import { NextResponse } from "next/server";
import { getPool, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Foto produk aktif untuk halaman publik: URL penyimpanan bertanda tangan berumur pendek (CSP img-src mengizinkan penyimpanan). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const url = await getProductImageUrl(getPool(), getStorage(), slug, id);
  if (!url) return new NextResponse("Foto tidak ditemukan.", { status: 404 });
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, max-age=120");
  return res;
}
