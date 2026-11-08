import { AppError, getFileDownloadUrl } from "@jadwalin/core";
import { NextResponse } from "next/server";
import { currentUser, getPool, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Otorisasi dulu (anggota workspace), lalu alihkan ke URL penyimpanan ber-tanda-tangan yang berumur 60 detik.
 * URL penyimpanan tidak pernah disimpan atau ditaruh di halaman.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/masuk", request.url));
  const { slug, id } = await params;
  try {
    const { url } = await getFileDownloadUrl(getPool(), { userId: user.id, slug }, getStorage(), id);
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    if (error instanceof AppError && (error.code === "not_found" || error.code === "forbidden")) {
      return new NextResponse("Berkas tidak ditemukan.", { status: 404 });
    }
    throw error;
  }
}
