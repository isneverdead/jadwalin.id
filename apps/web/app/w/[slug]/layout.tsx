import { countOpenBookingRequests, getContactPhone, listManualPayments, trialState } from "@jadwalin/core";
import { countPendingOrders } from "@jadwalin/module-rental";
import { listTickets } from "@jadwalin/module-tickets";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { DashNav, type NavItem } from "@/components/dash-nav";
import { DashShell } from "@/components/dash-shell";
import { getPool, myWorkspaces, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const ROLE: Record<string, string> = { owner: "Pemilik", admin: "Admin", staff: "Staf" };

export default async function UsahaLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const pool = getPool();
  const mine = (await myWorkspaces(user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  const actor = { userId: user.id, slug };
  const canManage = mine.role === "owner" || mine.role === "admin";
  // Masa uji paket Gratis (14 hari): setelah habis, dashboard terkunci kecuali halaman Paket.
  const trial = trialState(mine.plan, mine.planUntil);
  const onPaket = ((await headers()).get("x-pathname") ?? "").startsWith(`/w/${slug}/paket`);
  const locked = trial.expired && !onPaket;
  // Lencana "perlu perhatian"; kegagalan ambil data tidak boleh merusak halaman.
  const f = mine.features;
  const [payments, tickets, pendingRentals, openChanges] = await Promise.all([
    f.pembayaran ? listManualPayments(pool, actor, "open").catch(() => []) : Promise.resolve([]),
    f.tiket ? listTickets(pool, actor, { status: "aktif" }).catch(() => []) : Promise.resolve([]),
    f.sewa ? countPendingOrders(pool, actor).catch(() => 0) : Promise.resolve(0),
    f.jadwal ? countOpenBookingRequests(pool, actor).catch(() => 0) : Promise.resolve(0),
  ]);
  const contactPhone = canManage ? await getContactPhone(pool, actor).catch(() => "ok") : "ok";
  const base = `/w/${slug}`;
  const items: NavItem[] = [
    { href: base, label: "Ringkasan", hint: "Gambaran halaman dan anggota", icon: "home", exact: true },
    ...(f.sewa ? [{ href: `${base}/sewa`, label: "Pesanan sewa", hint: "Permintaan sewa pelanggan", icon: "key", badge: pendingRentals }, { href: `${base}/produk`, label: "Produk sewa", hint: "Katalog barang yang disewakan", icon: "box" }] : []),
    ...(f.jadwal ? [{ href: `${base}/jadwal`, label: "Jadwal & layanan", hint: "Jam kerja, layanan, harga/DP", icon: "calendar" }] : []),
    ...(f.jadwal ? [{ href: `${base}/perubahan`, label: "Perubahan booking", hint: "Pengajuan batal/refund dan ubah jadwal", icon: "swap", badge: openChanges }] : []),
    ...(f.tiket ? [{ href: `${base}/tiket`, label: "Tiket", hint: "Permintaan klien", icon: "ticket", badge: tickets.length }] : []),
    ...(f.pembayaran ? [{ href: `${base}/pembayaran`, label: "Pembayaran", hint: "Rekening/QRIS dan verifikasi bukti", icon: "wallet", badge: payments.filter((p) => p.status === "awaiting_verification").length }] : []),
    ...(f.berkas ? [{ href: `${base}/berkas`, label: "Berkas", hint: "Dokumen dan lampiran", icon: "file" }] : []),
    ...(canManage ? [{ href: `${base}/paket`, label: "Paket", hint: "Paket langganan dan upgrade", icon: "star" }] : []),
    ...(canManage ? [{ href: `${base}/audit`, label: "Log audit", hint: "Riwayat perubahan penting", icon: "shield" }, { href: `${base}/pengaturan`, label: "Pengaturan", hint: "Fitur yang dipakai usaha ini", icon: "gear" }] : []),
  ];

  return (
    <DashShell
      bizName={mine.name}
      aside={
        <>
          <Link href="/dashboard" className="side-back">← Semua usaha saya</Link>
          <div className="side-biz">
            <span className="avatar" aria-hidden="true">{mine.name.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{mine.name}</strong>
              <small>{ROLE[mine.role] ?? mine.role}</small>
            </div>
          </div>
          <DashNav items={items} />
          <a className="side-public" href={`/${slug}`} target="_blank" rel="noopener">
            <span>{f.sewa && !f.jadwal ? "Katalog publik" : "Halaman publik"}</span>
            <small>jadwalin.id/{slug} ↗</small>
          </a>
        </>
      }
    >
      {trial.onTrial && !trial.expired && (trial.daysLeft ?? 99) <= 7 && canManage && (
        <p className="notice warn" role="status"><b>Masa uji gratis tinggal {trial.daysLeft} hari.</b> Setelah itu halaman publik Anda tidak bisa dibuka pelanggan. <a href={`${base}/paket`}>Pilih paket</a></p>
      )}
      {locked ? (
        <section className="panel" role="alert">
          <div className="panel-head"><h2>Masa uji gratis sudah berakhir</h2></div>
          <p>Halaman publik {mine.name} ditutup sementara dan dashboard dikunci. Data Anda tetap aman dan kembali normal begitu paket aktif.</p>
          {canManage ? <p><a className="btn" href={`${base}/paket`}>Pilih paket</a></p> : <p>Minta pemilik usaha untuk memilih paket.</p>}
        </section>
      ) : (<>
      {!contactPhone && (
        <p className="notice warn" role="status"><b>Nomor WhatsApp usaha belum diisi (wajib).</b> Pelanggan memakainya untuk menghubungi Anda dari halaman booking. <a href={`${base}/pengaturan`}>Isi sekarang</a></p>
      )}
      {children}
      </>)}
    </DashShell>
  );
}
