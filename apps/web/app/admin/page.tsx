import { PLANS, adminOverview } from "@jadwalin/core";
import Link from "next/link";
import { getPool, requireSuperadmin, superadminEmails } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const admin = await requireSuperadmin();
  const ov = await adminOverview(getPool(), admin.id, superadminEmails());
  return (
    <>
      <div className="stat-grid">
        <Link className="stat" href="/admin/pendaftar"><span className="stat-n">{ov.usersLast7Days}</span><strong>Pendaftar 7 hari terakhir</strong><small>Total {ov.usersTotal} pengguna · {ov.usersUnverified} belum verifikasi email</small></Link>
        <Link className="stat" href="/admin/upgrade"><span className="stat-n">{ov.invoicesAwaiting}</span><strong>Upgrade menunggu verifikasi</strong><small>{ov.invoicesPending} tagihan menunggu bukti</small></Link>
        <div className="stat"><span className="stat-n">{ov.workspacesByPlan.perorangan + ov.workspacesByPlan.studio + ov.workspacesByPlan.lapangan + ov.workspacesByPlan.klinik}</span><strong>Usaha berbayar</strong><small>{(["gratis", "perorangan", "studio", "lapangan", "klinik"] as const).map((p) => `${PLANS[p].label}: ${ov.workspacesByPlan[p]}`).join(" · ")}</small></div>
      </div>
      <p><small>Pembayaran langganan sementara lewat transfer bank ke rekening platform (hard-coded). Bukti diverifikasi manual di menu Upgrade.</small></p>
    </>
  );
}
