import { FEATURE_INFO, type FeatureKey } from "@jadwalin/core";
import Link from "next/link";

/** Ditampilkan saat halaman fitur dibuka padahal fiturnya dimatikan (mis. dari tautan lama). Bukan 404: ada jalan keluar. */
export function FeatureOff({ feature, slug, canManage }: { feature: FeatureKey; slug: string; canManage: boolean }) {
  const info = FEATURE_INFO[feature];
  return (
    <>
      <header className="page-head"><div><h1>{info.label}</h1></div></header>
      <div className="empty">
        <strong>Fitur ini sedang dimatikan untuk usaha ini.</strong>
        <small>{info.description}</small>
        {canManage
          ? <p><Link className="btn" href={`/w/${slug}/pengaturan`}>Nyalakan di Pengaturan</Link></p>
          : <small>Minta pemilik atau admin untuk menyalakannya di menu Pengaturan.</small>}
      </div>
    </>
  );
}
