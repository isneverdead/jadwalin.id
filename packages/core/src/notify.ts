import { asWorker, schema, type Db } from "@jadwalin/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { AppError } from "./errors";
import { enqueueEmail } from "./notifications";

export interface Notice {
  to: string;
  subject: string;
  heading: string;
  paragraphs: string[];
  ctaLabel: string;
  url: string;
  /** Kunci idempoten: aksi yang sama tidak mengirim email dua kali. */
  dedupeKey: string;
  /** Untuk email yang memuat tautan rahasia (dihapus dari DB setelah terkirim). */
  sensitive?: boolean;
  sendAt?: Date;
}

/** Potong teks pengguna untuk pratinjau di email. */
export function preview(text: string, max = 300): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function send(w: Db, workspaceId: string, n: Notice): Promise<void> {
  try {
    await enqueueEmail(w, {
      workspaceId,
      to: n.to,
      template: n.sensitive ? "booking_notice" : "generic_notice",
      payload: { subject: n.subject, heading: n.heading, paragraphs: n.paragraphs, ctaLabel: n.ctaLabel, url: n.url },
      dedupeKey: n.dedupeKey,
      sendAt: n.sendAt,
    });
  } catch (error) {
    // Alamat email tak valid milik penerima tidak boleh membatalkan aksi bisnis; kesalahan lain tetap dilempar.
    if (!(error instanceof AppError && error.code === "invalid_input")) throw error;
  }
}

/**
 * Antre email di dalam transaksi aktor (klien, tamu, atau staf) lewat peralihan role sementara,
 * sehingga aksi mereka bisa mengantre email tanpa hak menulis outbox. Atomik dengan aksi bisnisnya.
 */
export async function notifyEmails(db: Db, workspaceId: string, notices: Notice[]): Promise<void> {
  const list = notices.filter((n) => n.to);
  if (list.length === 0) return;
  await asWorker(db, async (w) => {
    for (const n of list) await send(w, workspaceId, n);
  });
}

/**
 * Antre email ke staf yang relevan: anggota tertentu bila `memberId` diberikan, jika tidak semua owner/admin.
 * `excludeUserId` mengecualikan pelaku agar tidak mengirim email ke dirinya sendiri.
 */
export async function notifyStaff(
  db: Db,
  workspaceId: string,
  target: { assigneeMemberId: string | null; excludeUserId?: string },
  build: (email: string) => Notice,
): Promise<void> {
  await asWorker(db, async (w) => {
    const rows = await w
      .select({ email: schema.users.email })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          target.assigneeMemberId ? eq(schema.workspaceMembers.id, target.assigneeMemberId) : inArray(schema.workspaceMembers.role, ["owner", "admin"]),
          target.excludeUserId ? ne(schema.workspaceMembers.userId, target.excludeUserId) : undefined,
        ),
      );
    for (const r of rows) await send(w, workspaceId, build(r.email));
  });
}
