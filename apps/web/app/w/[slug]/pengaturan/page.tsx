import { FEATURE_INFO, FEATURE_KEYS, getChangeSettings, getContactPhone, listContactCandidates, listMyWorkspaces, listPaymentMethods } from "@jadwalin/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteWorkspaceAction, saveFeaturesAction } from "@/lib/actions";
import { saveChangeSettingsAction, saveContactPhoneAction } from "@/lib/change-actions";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function PengaturanPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; tersimpan?: string; ok?: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, tersimpan, ok } = await searchParams;
  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug);
  if (!mine || (mine.role !== "owner" && mine.role !== "admin")) notFound();
  const f = mine.features;
  const change = f.jadwal ? await getChangeSettings(getPool(), { userId: user.id, slug }) : null;
  const [contactPhone, candidates] = await Promise.all([getContactPhone(getPool(), { userId: user.id, slug }), listContactCandidates(getPool(), { userId: user.id, slug })]);
  const known = candidates.some((c) => c.phone === contactPhone);
  const needMethod = f.pembayaran && (await listPaymentMethods(getPool(), { userId: user.id, slug })).every((m) => !m.active);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Pengaturan</h1>
          <p>Pilih fitur yang dipakai {mine.name}. Menu yang tidak Anda pakai akan disembunyikan supaya dasbor tetap ringkas.</p>
        </div>
      </header>
      {(tersimpan || ok) && <p className="notice ok" role="status">Pengaturan tersimpan.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {needMethod && <p className="notice warn" role="status"><b>DP aktif, tinggal satu langkah lagi.</b> Tambahkan metode pembayaran supaya pelanggan tahu ke mana membayar. <Link href={`/w/${slug}/pembayaran#metode`}>Atur metode pembayaran →</Link></p>}

      <section className="panel">
        <div className="panel-head"><h2>Fitur</h2></div>
        <form action={saveFeaturesAction.bind(null, slug)}>
          <div className="feat-list">
            {FEATURE_KEYS.map((k) => (
              <label className="feat-row" key={k}>
                <span className="switch"><input type="checkbox" name={k} defaultChecked={f[k]} /><span className="track" aria-hidden="true" /></span>
                <span className="feat-text"><strong>{FEATURE_INFO[k].label}</strong><small>{FEATURE_INFO[k].description}</small><small className="feat-off">{FEATURE_INFO[k].offHint}</small></span>
              </label>
            ))}
            <p className="feat-fixed"><small>Selalu aktif: jadwal &amp; booking, serta log audit (keamanan).</small></p>
          </div>
          <button>Simpan pengaturan</button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Kontak WhatsApp untuk pelanggan <span className="badge warn">Wajib</span></h2><p>Nomor ini muncul sebagai tombol samar “Hubungi langsung” di halaman booking pelanggan. Pelanggan yang menekan tombol itu membuka WhatsApp Anda dengan konteks bookingnya (status, pembayaran, pengajuan) dan tautan booking. Anda juga bisa mengirim ulang tautan booking ke pelanggan dari menu Tiket, Pembayaran, dan Perubahan booking.</p></div>
        <form action={saveContactPhoneAction.bind(null, slug)}>
          <label>Nomor yang ditampilkan
            <select name="pick" defaultValue={known ? (contactPhone ?? "custom") : "custom"}>
                            {candidates.map((c) => <option key={c.phone} value={c.phone}>{c.name} ({c.role === "owner" ? "pemilik" : c.role === "admin" ? "admin" : "staf"}) · +{c.phone}</option>)}
              <option value="custom">Nomor lain…</option>
            </select>
          </label>
          <label><span>Nomor lain <small>(dipakai bila memilih “Nomor lain”)</small></span><input name="custom" type="tel" inputMode="tel" autoComplete="off" required={!known} placeholder="0812…" defaultValue={contactPhone && !known ? `+${contactPhone}` : ""} /></label>
          <small>Nomor anggota tim diambil dari profil akunnya. Nomor yang Anda pilih tampil publik bagi pemegang tautan booking.</small>
          <button>Simpan kontak</button>
        </form>
      </section>

      {change && (
        <section className="panel">
          <div className="panel-head"><h2>Perubahan oleh pelanggan</h2><p>Aturan saat pelanggan mengubah atau membatalkan booking dari tautannya. Pembatalan yang DP-nya sudah dibayar selalu menunggu persetujuan Anda.</p></div>
          <form action={saveChangeSettingsAction.bind(null, slug)}>
            <label>Ubah jadwal
              <select name="rescheduleMode" defaultValue={change.rescheduleMode}>
                <option value="auto">Langsung berlaku (Anda diberi tahu lewat email)</option>
                <option value="approval">Perlu persetujuan saya</option>
              </select>
            </label>
            <label><span>Batas waktu <small>(jam sebelum jadwal; 0 = tanpa batas)</small></span><input name="changeMinHours" type="number" min={0} max={720} defaultValue={change.changeMinHours} inputMode="numeric" /></label>
            <small>Di dalam batas waktu, pelanggan tidak bisa mengubah atau membatalkan sendiri dan diminta menghubungi Anda.</small>
            <button>Simpan aturan</button>
          </form>
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><h2>Informasi halaman</h2></div>
        <div className="list">
          <div className="list-row"><span className="grow"><strong>Nama</strong><small>{mine.name}</small></span></div>
          <div className="list-row"><span className="grow"><strong>Alamat halaman booking</strong><small>jadwalin.id/{mine.slug}</small></span></div>
          <div className="list-row"><span className="grow"><strong>Zona waktu</strong><small>{mine.timezone}</small></span></div>
        </div>
      </section>

      {mine.role === "owner" && (
        <section className="panel danger-zone">
          <div className="panel-head"><h2>Hapus usaha ini</h2></div>
          <p><small><b>{mine.name}</b> hilang dari dasbor, link <code>jadwalin.id/{mine.slug}</code> tidak bisa dibuka lagi, dan pelanggan tidak bisa memesan. Catatan pembayaran dan log audit tetap disimpan demi keamanan. Tindakan ini tidak bisa dibatalkan dari dasbor.</small></p>
          <form action={deleteWorkspaceAction.bind(null, slug)} className="danger-form">
            <label><span>Ketik <b>{mine.name}</b> untuk mengonfirmasi</span>
              <input name="confirmName" autoComplete="off" required placeholder={mine.name} />
            </label>
            <button className="danger">Hapus usaha ini</button>
          </form>
        </section>
      )}
    </>
  );
}
