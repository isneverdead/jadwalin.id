import { schema, withTenant, type Db } from "@jadwalin/db";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { claimGuestRecords, claimGuestRecordsIn } from "./claim";
import { AppError, isUniqueViolation } from "./errors";
import { DEFAULT_FEATURES, parseFeatures, type Features } from "./features";
import { normalizePhone } from "./phone";

/** Mencegah pembuatan workspace massal (bahan baku penyalahgunaan email). */
export const MAX_OWNED_WORKSPACES = 5;

export type Role = "owner" | "admin" | "staff";
const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, staff: 1 };

export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "www", "daftar", "masuk", "keluar", "dashboard", "w", "jadwal-saya",
  "login", "logout", "signup", "register", "support", "help", "bantuan", "static", "assets",
  "syarat", "privasi", "refund", "harga", "tentang", "jadwalin", "billing", "settings", "pengaturan",
  "undangan", "booking", "lupa-sandi", "reset-sandi", "tiket", "berkas", "jadwal", "sewa", "foto", "produk", "akun", "dpa", "penggunaan-wajar", "p", "u", "_next", "favicon", "robots", "sitemap",
]);

export function validateSlug(input: string): string {
  const slug = input.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(slug)) {
    throw new AppError("invalid_slug", "Nama link harus 3–32 karakter: huruf kecil, angka, dan tanda hubung.");
  }
  if (slug.includes("--") || RESERVED_SLUGS.has(slug)) {
    throw new AppError("invalid_slug", "Nama link ini tidak tersedia. Coba yang lain.");
  }
  return slug;
}

export interface Actor {
  userId: string;
  slug: string;
}

/** Cukup untuk operasi yang hanya butuh id workspace (mis. berkas); dipenuhi akses staf maupun klien. */
export interface WorkspaceRef {
  workspaceId: string;
}

export interface WorkspaceAccess extends WorkspaceRef {
  /** workspace_members.id milik pemanggil. */
  memberId: string;
  role: Role;
}

export async function audit(
  db: Db,
  e: { workspaceId: string; actorUserId: string | null; action: string; entityType: string; entityId: string; diff?: unknown },
) {
  await db.insert(schema.auditLog).values({ ...e, diff: e.diff ?? null });
}

export async function createWorkspace(
  pool: pg.Pool,
  userId: string,
  input: { name: string; slug: string; features?: Features; /** Nomor WhatsApp usaha (tampil ke pelanggan). Wajib di antarmuka web; opsional di sini untuk tes/skrip. */ contactPhone?: string },
): Promise<{ id: string; slug: string }> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new AppError("invalid_input", "Nama harus 2–80 karakter.");
  }
  const slug = validateSlug(input.slug);
  let contactPhone: string | null = null;
  if (input.contactPhone !== undefined) {
    try {
      contactPhone = normalizePhone(input.contactPhone);
    } catch {
      throw new AppError("invalid_input", "Nomor WhatsApp usaha wajib diisi dengan benar (format 08xx atau +62xx).");
    }
  }
  const owned = (await listMyWorkspaces(pool, userId)).filter((w) => w.role === "owner").length;
  if (owned >= MAX_OWNED_WORKSPACES) throw new AppError("invalid_input", `Satu akun maksimal memiliki ${MAX_OWNED_WORKSPACES} usaha. Hapus usaha yang tidak dipakai di Pengaturan, atau hubungi kami. Hubungi kami bila butuh lebih.`);
  const id = randomUUID();
  try {
    await withTenant(pool, { userId, workspaceId: id }, async (db) => {
      await db.insert(schema.workspaces).values({ id, slug, name, ownerUserId: userId, features: input.features ?? DEFAULT_FEATURES, contactPhone });
      await db.insert(schema.workspaceMembers).values({ workspaceId: id, userId, role: "owner" });
      await audit(db, { workspaceId: id, actorUserId: userId, action: "workspace.created", entityType: "workspace", entityId: id, diff: { slug, name } });
    });
  } catch (error) {
    if (isUniqueViolation(error, "workspaces_slug_unique")) {
      throw new AppError("slug_taken", "Nama link sudah dipakai. Coba yang lain.");
    }
    throw error;
  }
  return { id, slug };
}

export async function listMyWorkspaces(pool: pg.Pool, userId: string) {
  return withTenant(pool, { userId }, (db) =>
    db
      .select({ id: schema.workspaces.id, slug: schema.workspaces.slug, name: schema.workspaces.name, timezone: schema.workspaces.timezone, features: schema.workspaces.features, role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(and(eq(schema.workspaceMembers.userId, userId), isNull(schema.workspaces.deletedAt)))
      .orderBy(schema.workspaces.name),
  ).then((rows) => rows.map((r) => ({ ...r, features: parseFeatures(r.features) })));
}

/**
 * Pintu otorisasi: memastikan user anggota workspace `slug` dengan peran cukup, LALU membuka
 * konteks tenant. Id workspace tidak pernah dipercaya dari input mentah.
 * Bukan anggota → not_found (tidak membocorkan keberadaan workspace).
 */
export async function withWorkspace<T>(
  pool: pg.Pool,
  actor: Actor,
  minRole: Role,
  fn: (db: Db, access: WorkspaceAccess) => Promise<T>,
): Promise<T> {
  const found = await withTenant(pool, { userId: actor.userId }, (db) =>
    db
      .select({ workspaceId: schema.workspaces.id, memberId: schema.workspaceMembers.id, role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(and(eq(schema.workspaces.slug, actor.slug), eq(schema.workspaceMembers.userId, actor.userId), isNull(schema.workspaces.deletedAt)))
      .limit(1),
  );
  const access = found[0];
  if (!access) throw new AppError("not_found", "Halaman tidak ditemukan.");
  if (ROLE_RANK[access.role] < ROLE_RANK[minRole]) {
    throw new AppError("forbidden", "Anda tidak punya izin untuk tindakan ini.");
  }
  return withTenant(pool, { userId: actor.userId, workspaceId: access.workspaceId }, (db) => fn(db, access));
}

/**
 * Hapus halaman jadwal (soft delete, hanya pemilik). Data pembayaran/audit dipertahankan; halaman hilang dari semua daftar,
 * link publik/booking mengembalikan not_found, dan slug dibebaskan. Konfirmasi: pemilik harus mengetik nama persis.
 */
export async function deleteWorkspace(pool: pg.Pool, actor: Actor, confirmName: string): Promise<void> {
  await withWorkspace(pool, actor, "owner", async (db, access) => {
    const [ws] = await db.select({ name: schema.workspaces.name, slug: schema.workspaces.slug }).from(schema.workspaces).where(eq(schema.workspaces.id, access.workspaceId)).limit(1);
    if (!ws) throw new AppError("not_found", "Halaman tidak ditemukan.");
    if (confirmName.trim() !== ws.name) throw new AppError("invalid_input", "Nama yang diketik tidak sama. Penghapusan dibatalkan.");
    const freed = `hapus-${access.workspaceId.slice(0, 8)}-${ws.slug}`;
    await db.update(schema.workspaces).set({ deletedAt: new Date(), slug: freed }).where(eq(schema.workspaces.id, access.workspaceId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "workspace.deleted", entityType: "workspace", entityId: access.workspaceId, diff: { slug: ws.slug, name: ws.name } });
  });
}

export async function listMembers(pool: pg.Pool, actor: Actor) {
  return withWorkspace(pool, actor, "staff", (db, access) =>
    db
      .select({ id: schema.workspaceMembers.id, userId: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      // RLS juga memperlihatkan keanggotaan milik sendiri di workspace lain; filter eksplisit ke workspace aktif.
      .where(eq(schema.workspaceMembers.workspaceId, access.workspaceId))
      .orderBy(schema.users.name),
  );
}

export async function removeMember(pool: pg.Pool, actor: Actor, memberId: string) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const [target] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, memberId)).limit(1);
    if (!target) throw new AppError("not_found", "Anggota tidak ditemukan.");
    if (target.role === "owner") throw new AppError("forbidden", "Owner tidak bisa dikeluarkan.");
    if (target.role === "admin" && access.role !== "owner") {
      throw new AppError("forbidden", "Hanya owner yang bisa mengeluarkan admin.");
    }
    await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, memberId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "member.removed", entityType: "workspace_member", entityId: memberId, diff: { userId: target.userId, role: target.role } });
  });
}

export async function addClient(
  pool: pg.Pool,
  actor: Actor,
  input: { name: string; email?: string; phone?: string; userId?: string },
) {
  const name = input.name.trim();
  if (!name) throw new AppError("invalid_input", "Nama klien wajib diisi.");
  const phone = input.phone?.trim() ? normalizePhone(input.phone) : null;
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    let row: { id: string };
    try {
      [row] = (await db
        .insert(schema.workspaceClients)
        .values({ workspaceId: access.workspaceId, name, email: input.email?.trim().toLowerCase() || null, phone, userId: input.userId ?? null })
        .returning({ id: schema.workspaceClients.id })) as [{ id: string }];
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("invalid_input", "Klien dengan email itu sudah ada.");
      throw error;
    }
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "client.added", entityType: "workspace_client", entityId: row!.id });
    return row!;
  });
}

/** Portal klien "Jadwal saya": workspace tempat user tercatat sebagai klien. */
export async function listMyClientWorkspaces(pool: pg.Pool, userId: string) {
  await claimGuestRecords(pool, userId);
  return withTenant(pool, { userId }, (db) =>
    db
      .select({ workspaceId: schema.workspaces.id, slug: schema.workspaces.slug, name: schema.workspaces.name })
      .from(schema.workspaceClients)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceClients.workspaceId))
      .where(and(eq(schema.workspaceClients.userId, userId), isNull(schema.workspaces.deletedAt))),
  );
}

export async function listClients(pool: pg.Pool, actor: Actor) {
  return withWorkspace(pool, actor, "staff", (db) =>
    db
      .select({ id: schema.workspaceClients.id, userId: schema.workspaceClients.userId, name: schema.workspaceClients.name, email: schema.workspaceClients.email, phone: schema.workspaceClients.phone, blocked: schema.workspaceClients.blocked })
      .from(schema.workspaceClients)
      .orderBy(schema.workspaceClients.name),
  );
}

/** Blokir/buka klien yang menyalahgunakan portal. Hanya admin ke atas. */
export async function setClientBlocked(pool: pg.Pool, actor: Actor, clientId: string, blocked: boolean) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const updated = await db.update(schema.workspaceClients).set({ blocked }).where(eq(schema.workspaceClients.id, clientId)).returning({ id: schema.workspaceClients.id });
    if (updated.length === 0) throw new AppError("not_found", "Klien tidak ditemukan.");
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: blocked ? "client.blocked" : "client.unblocked", entityType: "workspace_client", entityId: clientId });
  });
}

export interface ClientAccess extends WorkspaceRef {
  userId: string;
  clientId: string;
  workspaceName: string;
  timezone: string;
  blocked: boolean;
  features: Features;
}

export interface ClientAccessOptions {
  /** Buat catatan klien otomatis untuk pengguna terverifikasi (dipakai saat membuka tiket pertama). */
  createIfMissing?: boolean;
  /** Operasi tulis ditolak untuk klien yang diblokir. */
  forWrite?: boolean;
}

/**
 * Pintu akses untuk PENGGUNA BIASA (bukan anggota) ke data tiketnya sendiri di workspace `slug`.
 * Konteks tenant memakai aktor 'client' sehingga RLS (migrasi 0009) membatasi baris pada milik pengguna
 * itu, apa pun yang dilakukan kode di bawahnya. Slug adalah pengenal publik; yang dilihat hanya nama workspace.
 */
export async function withClientAccess<T>(
  pool: pg.Pool,
  userId: string,
  slug: string,
  opts: ClientAccessOptions,
  fn: (db: Db, access: ClientAccess) => Promise<T>,
): Promise<T> {
  const [ws] = await withTenant(pool, { userId, publicSlug: slug }, (db) =>
    db.select({ id: schema.workspaces.id, name: schema.workspaces.name, timezone: schema.workspaces.timezone, features: schema.workspaces.features }).from(schema.workspaces).where(and(eq(schema.workspaces.slug, slug), isNull(schema.workspaces.deletedAt))).limit(1),
  );
  if (!ws) throw new AppError("not_found", "Halaman tidak ditemukan.");

  return withTenant(pool, { userId, workspaceId: ws.id, actor: "client" }, async (db) => {
    let [client] = await db.select().from(schema.workspaceClients).where(eq(schema.workspaceClients.userId, userId)).limit(1);
    if (!client) {
      // Mungkin pernah memesan sebagai tamu dengan email yang sama: klaim dulu (butuh email terverifikasi).
      await claimGuestRecordsIn(db, userId);
      [client] = await db.select().from(schema.workspaceClients).where(eq(schema.workspaceClients.userId, userId)).limit(1);
    }
    if (!client) {
      if (!opts.createIfMissing) throw new AppError("not_found", "Anda belum terdaftar sebagai klien di sini.");
      const [me] = await db.select({ name: schema.users.name, email: schema.users.email, phone: schema.users.phone, verified: schema.users.emailVerified }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      if (!me?.verified) throw new AppError("forbidden", "Verifikasi email Anda dulu sebelum menghubungi.");
      // Idempoten: klik ganda/tab ganda memicu pembuatan serentak; yang kalah balapan memakai baris pemenang.
      const inserted = await db
        .insert(schema.workspaceClients)
        .values({ workspaceId: ws.id, userId, name: me.name, email: me.email.toLowerCase(), phone: me.phone })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) {
        await audit(db, { workspaceId: ws.id, actorUserId: userId, action: "client.self_registered", entityType: "workspace_client", entityId: inserted[0]!.id });
      }
      [client] = await db.select().from(schema.workspaceClients).where(eq(schema.workspaceClients.userId, userId)).limit(1);
    }
    if (opts.forWrite && client!.blocked) throw new AppError("forbidden", "Akun Anda tidak dapat mengirim pesan ke halaman ini.");
    return fn(db, { workspaceId: ws.id, userId, clientId: client!.id, workspaceName: ws.name, timezone: ws.timezone, blocked: client!.blocked, features: parseFeatures(ws.features) });
  });
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Halaman publik jadwalin.id/<slug>: hanya nama dan zona waktu; berlaku untuk pengunjung yang belum masuk. */
export async function getPublicWorkspace(pool: pg.Pool, slug: string, userId?: string) {
  const [ws] = await withTenant(pool, { userId: userId ?? NIL_UUID, publicSlug: slug.toLowerCase() }, (db) =>
    db.select({ name: schema.workspaces.name, slug: schema.workspaces.slug, timezone: schema.workspaces.timezone, features: schema.workspaces.features }).from(schema.workspaces).where(and(eq(schema.workspaces.slug, slug.toLowerCase()), isNull(schema.workspaces.deletedAt))).limit(1),
  );
  return ws ? { ...ws, features: parseFeatures(ws.features) } : null;
}
