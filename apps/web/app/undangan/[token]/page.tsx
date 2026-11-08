import { previewInvitation } from "@jadwalin/core";
import Link from "next/link";
import { redirect } from "next/navigation";
import { acceptInvitationAction } from "@/lib/actions";
import { currentUser, getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function UndanganPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const user = await currentUser();
  if (!user) redirect(`/masuk?next=${encodeURIComponent(`/undangan/${token}`)}`);

  const invite = await previewInvitation(getPool(), user.id, token);

  if (!invite) {
    return (
      <>
        <h1>Undangan tidak valid</h1>
        <p>Undangan ini tidak ditemukan, sudah dipakai, atau sudah kedaluwarsa. Minta pengundang mengirim yang baru.</p>
        <p><Link href="/dashboard">Ke dashboard</Link></p>
      </>
    );
  }

  return (
    <>
      <h1>Undangan bergabung</h1>
      <p>
        Anda diundang bergabung ke <strong>{invite.workspaceName}</strong> sebagai <strong>{invite.role === "admin" ? "admin" : "staf"}</strong>.
      </p>
      {invite.emailMismatch && (
        <p className="error" role="alert">
          Undangan ini ditujukan ke <strong>{invite.invitedEmail}</strong>, sedangkan Anda masuk sebagai <strong>{user.email}</strong>. Keluar, lalu masuk dengan email yang diundang.
        </p>
      )}
      {!invite.emailMismatch && invite.needsVerification && <p className="error" role="alert">Verifikasi email Anda dulu sebelum menerima undangan.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {invite.canAccept && (
        <form action={acceptInvitationAction.bind(null, token)}>
          <button>Terima undangan</button>
        </form>
      )}
    </>
  );
}
