import { AppError, listAuditLog } from "@jadwalin/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const rows = await listAuditLog(getPool(), { userId: user.id, slug }, { limit: 100 }).catch((e) => {
    if (e instanceof AppError && (e.code === "not_found" || e.code === "forbidden")) return null;
    throw e;
  });
  if (!rows) notFound();
  return (
    <>
      <p><Link href={`/w/${slug}`}>← Workspace</Link></p>
      <h1>Log audit</h1>
      <p>100 kejadian terakhir (hanya admin dan pemilik yang dapat melihat). Isi perubahan tidak ditampilkan di sini.</p>
      <table>
        <thead><tr><th>Waktu</th><th>Aksi</th><th>Oleh</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.createdAt.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</td>
              <td><code>{r.action}</code></td>
              <td>{r.actorName ?? "sistem / tamu"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
