import { PLANS, PLAN_IDS, adminListUsers, waLink } from "@jadwalin/core";
import { ConfirmButton } from "@/components/confirm-button";
import { fmtDateTime } from "@/lib/format";
import { setPlanAction, setSuspendedAction } from "@/lib/admin-actions";
import { getPool, requireSuperadmin, superadminEmails } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string; error?: string }> }) {
  const admin = await requireSuperadmin();
  const { q, error } = await searchParams;
  const allowed = superadminEmails();
  const rows = await adminListUsers(getPool(), admin.id, allowed, { q, limit: 60 });
  return (
    <section className="panel">
      <div className="panel-head"><h2>Pengguna</h2><p>Cari nama, email, atau nomor HP. Atur paket usaha secara manual atau tangguhkan akun (sesinya langsung tidak berlaku).</p></div>
      <form method="get" className="inline-form" role="search">
        <input name="q" defaultValue={q ?? ""} placeholder="Cari nama, email, atau nomor HP" aria-label="Cari pengguna" />
        <button>Cari</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {rows.length === 0 && <div className="empty"><strong>Tidak ada pengguna yang cocok.</strong></div>}
      {rows.map((u) => {
        const isAdmin = allowed.includes(u.email.toLowerCase());
        return (
          <div className="card pay-row" key={u.id}>
            <div className="pay-info">
              <strong>{u.name}</strong> {isAdmin && <span className="badge">Superadmin</span>} {u.suspendedAt && <span className="badge warn">Ditangguhkan</span>}
              <small>{u.email} · {u.phone ? `+${u.phone}` : "tanpa nomor HP"} · {u.emailVerified ? "email terverifikasi" : "belum verifikasi"}</small>
              <small>Daftar {fmtDateTime(u.createdAt, "Asia/Jakarta")}</small>
              {u.phone && <small><a href={waLink(u.phone, `Halo ${u.name}, ini dari jadwalin.id.`)} target="_blank" rel="noopener">Hubungi lewat WhatsApp ↗</a></small>}
              {u.workspaces.map((w) => (
                <form key={w.id} action={setPlanAction.bind(null, w.id)} className="inline-form plan-set">
                  <span><strong>{w.name}</strong> <small>({w.role}) · jadwalin.id/{w.slug}</small></span>
                  <select name="plan" defaultValue={w.plan} aria-label={`Paket ${w.name}`}>{PLAN_IDS.map((p) => <option key={p} value={p}>{PLANS[p].label}</option>)}</select>
                  <input name="until" type="date" defaultValue={w.planUntil ? w.planUntil.toISOString().slice(0, 10) : ""} aria-label={`Berlaku sampai ${w.name}`} />
                  <button className="btn-ghost">Simpan paket</button>
                </form>
              ))}
            </div>
            {!isAdmin && (
              <form action={setSuspendedAction.bind(null, u.id, !u.suspendedAt)}>
                <ConfirmButton className="link danger-link" message={u.suspendedAt ? `Aktifkan kembali ${u.name}?` : `Tangguhkan ${u.name}? Sesinya langsung tidak berlaku dan ia tidak bisa masuk.`}>{u.suspendedAt ? "Aktifkan kembali" : "Tangguhkan akun"}</ConfirmButton>
              </form>
            )}
          </div>
        );
      })}
    </section>
  );
}
