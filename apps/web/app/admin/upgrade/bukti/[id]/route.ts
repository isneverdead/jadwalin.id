import { AppError, adminInvoiceProofUrl } from "@jadwalin/core";
import { NextResponse } from "next/server";
import { currentUser, getPool, getStorage, superadminEmails } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Bukti transfer langganan hanya untuk superadmin: otorisasi (di core), lalu alihkan ke URL bertanda tangan berumur pendek. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("Tidak ditemukan.", { status: 404 });
  const { id } = await params;
  try {
    const { url } = await adminInvoiceProofUrl(getPool(), user.id, superadminEmails(), getStorage(), id);
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    if (error instanceof AppError) return new NextResponse("Tidak ditemukan.", { status: 404 });
    throw error;
  }
}
