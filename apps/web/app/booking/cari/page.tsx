import { recoverBookingAction } from "@/lib/booking-actions";
import { loadTurnstileEnv } from "@jadwalin/config";
import { Turnstile } from "@/components/turnstile";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pulihkan booking · jadwalin.id" };

/** Pemulihan tautan booking: kode booking + nomor HP (tanpa email). Tautan lama berhenti berlaku. */
export default async function RecoverBookingPage({ searchParams }: { searchParams: Promise<{ u?: string; kode?: string; error?: string }> }) {
  const sp = await searchParams;
  const siteKey = loadTurnstileEnv().siteKey;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <h1>Pulihkan booking Anda</h1>
      <p>Masukkan kode booking dan nomor HP yang Anda pakai saat memesan. Kode ada di pesan konfirmasi atau yang dikirim penyedia jasa (contoh: JDW-7K3M9Q).</p>
      <form action={recoverBookingAction} className="panel">
        <label><span>Alamat halaman usaha <small>(bagian setelah jadwalin.id/)</small></span><input name="u" required defaultValue={sp.u ?? ""} placeholder="nama-usaha" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        <label>Kode booking<input name="kode" required defaultValue={sp.kode ?? ""} placeholder="JDW-XXXXXX" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={10} /></label>
        <label>Nomor HP<input name="phone" type="tel" required inputMode="tel" autoComplete="tel" placeholder="0812…" /></label>
        <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}><label>Situs web<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        {siteKey && <Turnstile siteKey={siteKey} nonce={nonce} />}
        {sp.error && <p className="error" role="alert">{sp.error}</p>}
        <button className="cta">Buka booking saya</button>
        <small>Demi keamanan, tautan lama yang Anda simpan atau terima berhenti berlaku setelah Anda memulihkan booking dan diganti tautan baru.</small>
      </form>
    </>
  );
}
