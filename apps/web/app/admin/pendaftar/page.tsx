import { adminListUsers, waLink } from "@jadwalin/core";
import { fmtDateTime } from "@/lib/format";
import { getPool, requireSuperadmin, superadminEmails } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Pendaftar terbaru: siapa yang baru masuk, sudah verifikasi email, sudah punya usaha atau belum, plus pintasan sapa lewat WhatsApp. */
export default async function SignupsPage() {
  const admin = await requireSuperadmin();
  const rows = await adminListUsers(getPool(), admin.id, superadminEmails(), { limit: 40 });
  return (
    <section className="panel">
      <div className="panel-head"><h2>Pendaftar baru</h2><p>40 pengguna terbaru. Tombol WhatsApp membuka chat dengan pesan sapaan siap kirim (hanya bila pengguna punya nomor di profilnya).</p></div>
      {rows.length === 0 && <div className="empty"><strong>Belum ada pendaftar.</strong></div>}
      <div className="list">
        {rows.map((u) => {
          const biz = u.workspaces.map((w) => `${w.name} (${w.slug})`).join(", ");
          const text = `Halo ${u.name}, terima kasih sudah mendaftar di jadwalin.id! ${u.workspaces.length ? `Saya lihat usaha Anda "${u.workspaces[0]!.name}" sudah dibuat. Ada yang bisa kami bantu?` : "Sudah sempat membuat halaman jadwal Anda? Kabari saya bila ada kendala."}`;
          return (
            <div className="list-row" key={u.id}>
              <span className="grow">
                <strong>{u.name}</strong>
                <small>{u.email} · {u.phone ? `+${u.phone}` : "tanpa nomor HP"}</small>
                <small>Daftar {fmtDateTime(u.createdAt, "Asia/Jakarta")} · {biz || "belum punya usaha"}</small>
              </span>
              <span className="stack-end">
                <span className={`badge ${u.emailVerified ? "ok" : "warn"}`}>{u.emailVerified ? "Email terverifikasi" : "Belum verifikasi"}</span>
                {u.phone && <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener" href={waLink(u.phone, text)}>Sapa lewat WhatsApp ↗</a>}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
