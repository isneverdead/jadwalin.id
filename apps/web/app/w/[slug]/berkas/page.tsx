import { AppError, listFiles } from "@jadwalin/core";
import Link from "next/link";
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
  const files = await listFiles(getPool(), { userId: user.id, slug }).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!files) notFound();

  return (
    <>
      <p><Link href={`/w/${slug}`}>← Workspace</Link></p>
      <h1>Berkas</h1>
      <Uploader slug={slug} />

      <h2>Berkas tersimpan</h2>
      {files.length === 0 && <p>Belum ada berkas.</p>}
      {files.map((f) => (
        <div className="card" key={f.id}>
          <span>{f.filename} <small>{formatSize(f.sizeBytes)} · {f.createdAt.toLocaleDateString("id-ID")}</small></span>
          <a href={`/w/${slug}/berkas/${f.id}/unduh`}>Unduh</a>
        </div>
      ))}
    </>
  );
}
