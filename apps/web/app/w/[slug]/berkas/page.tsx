import { AppError, listFiles, listMyWorkspaces } from "@jadwalin/core";
import { FeatureOff } from "@/components/feature-off";
import { notFound } from "next/navigation";
import { getPool, requireUser } from "@/lib/server";
import { Uploader } from "./uploader";

export const dynamic = "force-dynamic";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function BerkasPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  if (!mine.features.berkas) return <FeatureOff feature="berkas" slug={slug} canManage={mine.role !== "staff"} />;
  const files = await listFiles(getPool(), { userId: user.id, slug }).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!files) notFound();

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Berkas</h1>
          <p>Simpan dokumen Anda dengan aman. Berkas hanya bisa diunduh lewat tautan sementara.</p>
        </div>
      </header>
      <section className="panel">
        <div className="panel-head"><h2>Unggah berkas</h2></div>
        <Uploader slug={slug} />
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Berkas tersimpan {files.length > 0 && <span className="badge">{files.length}</span>}</h2></div>
        {files.length === 0 && <div className="empty"><strong>Belum ada berkas.</strong><small>Unggah dokumen pertama Anda di atas.</small></div>}
        <div className="list">
          {files.map((f) => (
            <div className="list-row" key={f.id}>
              <span className="file-ico" aria-hidden="true">{(f.filename.split(".").pop() ?? "").slice(0, 4).toUpperCase()}</span>
              <span className="grow"><strong>{f.filename}</strong><small>{formatSize(f.sizeBytes)} · {f.createdAt.toLocaleDateString("id-ID")}</small></span>
              <a className="btn btn-ghost" href={`/w/${slug}/berkas/${f.id}/unduh`}>Unduh</a>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
