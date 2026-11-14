import { AppError, bookingPaymentHooks, createWorkspace, DEFAULT_FEATURES, getManualPaymentView, hashToken, ManualProvider, reviewPayment, savePaymentMethod, setFeatures, withWorkspace, type PaymentDeps } from "@jadwalin/core";
import { createPool, withTenant } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays, cancelRentalByToken, createProduct, dayWindows, daysBetweenInclusive, getProductAvailability, getProductImageUrl, getPublicProduct, getRentalByToken, listOrders, listProducts, listPublicProducts,
  localMidnight, parseDate, rentalWindow, requestRental, setOrderStatus, setProductActive, updateProduct,
} from "../src";

const NOW = new Date("2035-03-05T00:00:00Z"); // Senin 07:00 WIB
const opts = { baseUrl: "http://t.local", now: NOW };

describe("tanggal sewa (murni)", () => {
  it("parseDate menolak tanggal ngawur; hitung hari inklusif; tambah hari melewati bulan", () => {
    expect(() => parseDate("2035-02-30")).toThrow(AppError);
    expect(() => parseDate("10-03-2035")).toThrow(AppError);
    expect(daysBetweenInclusive("2035-03-10", "2035-03-10")).toBe(1);
    expect(daysBetweenInclusive("2035-03-30", "2035-04-02")).toBe(4);
    expect(addDays("2035-02-28", 1)).toBe("2035-03-01");
  });
  it("jendela sewa = tengah malam lokal; WIB (+7) dan WITA (+8) berbeda sejam", () => {
    expect(localMidnight("2035-03-10", "Asia/Jakarta").toISOString()).toBe("2035-03-09T17:00:00.000Z");
    expect(localMidnight("2035-03-10", "Asia/Makassar").toISOString()).toBe("2035-03-09T16:00:00.000Z");
    const w = rentalWindow("2035-03-10", "2035-03-12", "Asia/Jakarta", NOW);
    expect(w.days).toBe(3);
    expect(w.endsAt.getTime() - w.startsAt.getTime()).toBe(3 * 24 * 3600_000);
  });
  it("menolak tanggal lampau, urutan terbalik, dan lebih dari 90 hari; hari ini boleh", () => {
    expect(() => rentalWindow("2035-03-04", "2035-03-06", "Asia/Jakarta", NOW)).toThrow(/masa lalu/);
    expect(() => rentalWindow("2035-03-12", "2035-03-10", "Asia/Jakarta", NOW)).toThrow(AppError);
    expect(() => rentalWindow("2035-03-10", "2035-07-10", "Asia/Jakarta", NOW)).toThrow(/Maksimal/);
    expect(rentalWindow("2035-03-05", "2035-03-05", "Asia/Jakarta", NOW).days).toBe(1);
  });
  it("dayWindows berurutan tanpa celah", () => {
    const w = dayWindows("2035-03-10", 3, "Asia/Jakarta");
    expect(w.map((x) => x.date)).toEqual(["2035-03-10", "2035-03-11", "2035-03-12"]);
    expect(w[0]!.end.getTime()).toBe(w[1]!.start.getTime());
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("sewa barang (Postgres asli)", () => {
  let pool: pg.Pool;
  const sfx = Math.random().toString(36).slice(2, 8);
  let owner: { userId: string; slug: string };
  let staff: { userId: string; slug: string };
  let outsider: string;
  let slug: string;
  let wsId: string;
  let productId: string;
  let n = 0;
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));
  const guest = (extra: Partial<Parameters<typeof requestRental>[3]> = {}) => ({ name: "Tamu Sewa", email: `tamu${++n}-${sfx}@rt.local`, phone: "081234567890", startDate: "2035-03-10", endDate: "2035-03-12", privacyAck: true, ...extra });
  const mk = async (k: string) => (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [`${k}-${sfx}@rt.local`, k])).rows[0].id as string;

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    const o = await mk("owner");
    const s = await mk("staff");
    outsider = await mk("outsider");
    slug = `rt-${sfx}`;
    wsId = (await createWorkspace(pool, o, { name: "Rental Uji", slug, features: { ...DEFAULT_FEATURES, sewa: true } })).id;
    owner = { userId: o, slug };
    staff = { userId: s, slug };
    // staf: anggota biasa
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'staff')`, [wsId, s]);
    productId = (await createProduct(pool, owner, { name: "Motor Matic", category: "Motor", description: "Bensin penuh", pricePerDayIdr: 100000, depositIdr: 500000, units: 2 })).id;
  });
  afterAll(async () => pool?.end());

  it("katalog: hanya admin yang mengelola; fitur mati menolak; produk tampil di halaman publik", async () => {
    expect(await code(createProduct(pool, staff, { name: "Mobil", pricePerDayIdr: 1, units: 1 }))).toBe("forbidden");
    expect(await code(createProduct(pool, owner, { name: "x", pricePerDayIdr: 1000, units: 1 }))).toBe("invalid_input");
    expect(await code(createProduct(pool, owner, { name: "Gratis?", pricePerDayIdr: 1.5, units: 1 }))).toBe("invalid_input");
    expect(await code(createProduct(pool, owner, { name: "Banyak", pricePerDayIdr: 1000, units: 99 }))).toBe("invalid_input");
    expect(await code(createProduct(pool, owner, { name: "Foto palsu", pricePerDayIdr: 1000, units: 1, imageFileId: "00000000-0000-0000-0000-000000000000" }))).toBe("invalid_input");
    expect((await listProducts(pool, staff)).some((p) => p.id === productId)).toBe(true);
    const pub = await listPublicProducts(pool, slug);
    expect(pub?.products.map((p) => p.name)).toContain("Motor Matic");
    expect(await getPublicProduct(pool, slug, productId)).not.toBeNull();
    expect(await getPublicProduct(pool, slug, "bukan-uuid")).toBeNull();
  });

  it("dua unit: dua tamu boleh menyewa tanggal yang sama, yang ketiga ditolak; tanggal berbeda tetap bisa", async () => {
    const a = await requestRental(pool, slug, productId, guest(), opts);
    const b = await requestRental(pool, slug, productId, guest(), opts);
    expect(a.totalIdr).toBe(300000); // 3 hari x 100.000
    expect(await code(requestRental(pool, slug, productId, guest(), opts))).toBe("slot_unavailable");
    expect(await code(requestRental(pool, slug, productId, guest({ startDate: "2035-03-12", endDate: "2035-03-13" }), opts))).toBe("slot_unavailable"); // beririsan di 12
    expect(await code(requestRental(pool, slug, productId, guest({ startDate: "2035-03-13", endDate: "2035-03-14" }), opts))).toBe("ok");
    const av = await getProductAvailability(pool, slug, productId, { fromDate: "2035-03-09", count: 7, now: NOW });
    // 9 bebas; 10–12 penuh (2 unit); 13–15: satu unit terpakai tersisa satu → masih tersedia.
    expect(av.map((d) => d.available)).toEqual([true, false, false, false, true, true, true]);
    expect(a.token).not.toBe(b.token);
  });

  it("penyewa tanpa email (hanya HP/WhatsApp): pesanan tercatat, tak ada email ke penyewa, nomor yang sama = satu klien", async () => {
    const phone = `0815${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const mk = (startDate: string, endDate: string) => ({ name: "Penyewa WA", phone, startDate, endDate, privacyAck: true }) as Parameters<typeof requestRental>[3];
    const a = await requestRental(pool, slug, productId, mk("2035-04-10", "2035-04-11"), opts);
    const b = await requestRental(pool, slug, productId, mk("2035-04-20", "2035-04-21"), opts);
    expect(a.token).not.toBe(b.token);
    const clients = (await pool.query(`SELECT email FROM workspace_clients WHERE phone = $1`, [phone.replace(/^0/, "62")])).rows;
    expect(clients).toHaveLength(1);
    expect(clients[0].email).toBeNull();
    expect(await code(requestRental(pool, slug, productId, { ...mk("2035-04-25", "2035-04-26"), phone: undefined }, opts))).toBe("invalid_input"); // HP tetap wajib
  });

  it("masukan tamu divalidasi: privasi, email, HP, tanggal lampau", async () => {
    expect(await code(requestRental(pool, slug, productId, guest({ privacyAck: false }), opts))).toBe("invalid_input");
    expect(await code(requestRental(pool, slug, productId, guest({ email: "bukan-email" }), opts))).toBe("invalid_input");
    expect(await code(requestRental(pool, slug, productId, guest({ phone: "abc" }), opts))).toBe("invalid_input");
    expect(await code(requestRental(pool, slug, productId, guest({ startDate: "2035-03-01", endDate: "2035-03-02" }), opts))).toBe("invalid_input");
    expect(await code(requestRental(pool, slug, "00000000-0000-0000-0000-000000000000", guest({ startDate: "2035-04-10", endDate: "2035-04-11" }), opts))).toBe("not_found");
  });

  it("constraint database menolak tumpang tindih unit yang sama, apa pun kodenya (aturan #8)", async () => {
    const clientId = (await pool.query(`SELECT id FROM workspace_clients WHERE workspace_id = $1 LIMIT 1`, [wsId])).rows[0].id as string;
    const resId = (await pool.query(`SELECT resource_id FROM rental_products WHERE id = $1`, [productId])).rows[0].resource_id as string;
    const ins = (unit: number, range: string, status: string, tok: string) =>
      pool.query(`INSERT INTO reservations (workspace_id, resource_id, unit_no, client_id, during, status, token_hash) VALUES ($1, $2, $3, $4, $5::tstzrange, $6, $7)`, [wsId, resId, unit, clientId, range, status, tok]);
    await ins(2, "[2035-06-01,2035-06-05)", "confirmed", `raw1-${sfx}`);
    await expect(ins(2, "[2035-06-03,2035-06-08)", "pending", `raw2-${sfx}`)).rejects.toMatchObject({ code: "23P01" });
    await ins(2, "[2035-06-03,2035-06-08)", "cancelled", `raw3-${sfx}`); // dibatalkan tidak menahan
    await ins(1, "[2035-06-03,2035-06-08)", "pending", `raw4-${sfx}`); // unit lain boleh
  });

  it("RLS: tamu hanya melihat pesanan bertokennya; tidak bisa mengubah/menulis sembarangan; klien portal tertutup", async () => {
    const mine = await requestRental(pool, slug, productId, guest({ startDate: "2035-05-10", endDate: "2035-05-11" }), opts);
    const other = await requestRental(pool, slug, productId, guest({ startDate: "2035-05-20", endDate: "2035-05-21" }), opts);
    const view = await getRentalByToken(pool, mine.token);
    expect(view).toMatchObject({ productName: "Motor Matic", days: 2, totalIdr: 200000, status: "pending", canCancel: true });
    expect(await getRentalByToken(pool, "token-ngawur")).toBeNull();
    const otherHash = hashToken(other.token);
    // tamu dengan token milikku: pesanan orang lain tak terbaca di rental_orders
    const orders = await withTenant(pool, { userId: "00000000-0000-0000-0000-000000000000", workspaceId: wsId, actor: "public", bookingTokenHash: hashToken(mine.token) }, (db) => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rental_orders`));
    expect(orders.rows[0]!.n).toBe(1);
    // tidak bisa membatalkan/mengubah reservasi orang lain
    const upd = await withTenant(pool, { userId: "00000000-0000-0000-0000-000000000000", workspaceId: wsId, actor: "public", bookingTokenHash: hashToken(mine.token) }, (db) => db.execute(sql`UPDATE reservations SET status = 'cancelled' WHERE token_hash = ${otherHash}`));
    expect(upd.rowCount).toBe(0);
    // tidak bisa membuat reservasi langsung berstatus confirmed, dan tidak bisa menulis produk
    const clientId = (await pool.query(`SELECT id FROM workspace_clients WHERE workspace_id = $1 LIMIT 1`, [wsId])).rows[0].id as string;
    const resId = (await pool.query(`SELECT resource_id FROM rental_products WHERE id = $1`, [productId])).rows[0].resource_id as string;
    await expect(withTenant(pool, { userId: "00000000-0000-0000-0000-000000000000", workspaceId: wsId, actor: "public" }, (db) => db.execute(sql`INSERT INTO reservations (workspace_id, resource_id, unit_no, client_id, during, status, token_hash) VALUES (${wsId}, ${resId}, 1, ${clientId}, '[2036-01-01,2036-01-02)'::tstzrange, 'confirmed', ${`evil-${sfx}`})`))).rejects.toThrow();
    const prodUpd = await withTenant(pool, { userId: "00000000-0000-0000-0000-000000000000", workspaceId: wsId, actor: "public" }, (db) => db.execute(sql`UPDATE rental_products SET price_per_day_idr = 1`));
    expect(prodUpd.rowCount).toBe(0);
    // klien terdaftar (portal) tertutup total
    const clientRows = await withTenant(pool, { userId: outsider, workspaceId: wsId, actor: "client" }, (db) => db.execute<{ n: number }>(sql`SELECT (SELECT count(*) FROM rental_products)::int + (SELECT count(*) FROM reservations)::int + (SELECT count(*) FROM rental_orders)::int AS n`));
    expect(clientRows.rows[0]!.n).toBe(0);
    // aktor tanpa konteks sama sekali tidak melihat apa pun
    const none = await withTenant(pool, { userId: outsider }, (db) => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rental_orders`));
    expect(none.rows[0]!.n).toBe(0);
  });

  it("alur pesanan: konfirmasi → ambil → selesai; transisi tak sah ditolak; email ke pelanggan", async () => {
    const r = await requestRental(pool, slug, productId, guest({ startDate: "2035-07-10", endDate: "2035-07-11", email: `alur-${sfx}@rt.local` }), opts);
    const row = (await listOrders(pool, staff, "all")).find((o) => o.id === r.orderId)!;
    expect(row).toMatchObject({ status: "pending", productName: "Motor Matic", days: 2 });
    expect(await code(setOrderStatus(pool, staff, r.orderId, "active", opts))).toBe("invalid_input"); // belum dikonfirmasi
    await setOrderStatus(pool, staff, r.orderId, "confirmed", opts);
    expect((await getRentalByToken(pool, r.token))?.status).toBe("confirmed");
    expect((await pool.query(`SELECT 1 FROM notification_outbox WHERE workspace_id = $1 AND recipient = $2 AND payload->>'subject' LIKE 'Pesanan sewa dikonfirmasi%'`, [wsId, `alur-${sfx}@rt.local`])).rowCount).toBe(1);
    await setOrderStatus(pool, staff, r.orderId, "active", opts);
    await setOrderStatus(pool, staff, r.orderId, "completed", opts);
    expect(await code(setOrderStatus(pool, staff, r.orderId, "confirmed", opts))).toBe("invalid_input");
    expect(await code(setOrderStatus(pool, { userId: outsider, slug }, r.orderId, "confirmed", opts))).toBe("not_found");
  });

  it("tamu membatalkan: unit bebas lagi, tidak bisa dua kali; ditolak pemilik juga membebaskan", async () => {
    const solo = await createProduct(pool, owner, { name: "Kamera Tunggal", pricePerDayIdr: 50000, units: 1 });
    const a = await requestRental(pool, slug, solo.id, guest({ startDate: "2035-08-10", endDate: "2035-08-12" }), opts);
    expect(await code(requestRental(pool, slug, solo.id, guest({ startDate: "2035-08-11", endDate: "2035-08-11" }), opts))).toBe("slot_unavailable");
    await cancelRentalByToken(pool, a.token, opts);
    expect(await code(cancelRentalByToken(pool, a.token, opts))).toBe("invalid_input");
    const b = await requestRental(pool, slug, solo.id, guest({ startDate: "2035-08-11", endDate: "2035-08-11" }), opts);
    const order = (await listOrders(pool, owner, "all")).find((o) => o.productName === "Kamera Tunggal" && o.status === "pending")!;
    await setOrderStatus(pool, owner, order.id, "rejected", opts);
    expect(await code(requestRental(pool, slug, solo.id, guest({ startDate: "2035-08-11", endDate: "2035-08-11" }), opts))).toBe("ok");
    expect(b.token).toBeTruthy();
  });

  it("produk nonaktif hilang dari katalog; ubah produk; unit tidak bisa dikurangi saat dipakai; fitur mati menutup halaman publik", async () => {
    const p = await createProduct(pool, owner, { name: "Tenda Dome", pricePerDayIdr: 80000, units: 3 });
    await requestRental(pool, slug, p.id, guest({ startDate: "2035-09-10", endDate: "2035-09-10" }), opts); // unit 1
    await requestRental(pool, slug, p.id, guest({ startDate: "2035-09-10", endDate: "2035-09-10" }), opts); // unit 2
    await requestRental(pool, slug, p.id, guest({ startDate: "2035-09-10", endDate: "2035-09-10" }), opts); // unit 3
    expect(await code(updateProduct(pool, owner, p.id, { name: "Tenda Dome", pricePerDayIdr: 80000, units: 2 }))).toBe("invalid_input");
    await updateProduct(pool, owner, p.id, { name: "Tenda Dome 4P", pricePerDayIdr: 90000, depositIdr: 100000, units: 3 });
    expect((await listProducts(pool, owner)).find((x) => x.id === p.id)).toMatchObject({ name: "Tenda Dome 4P", pricePerDayIdr: 90000 });
    await setProductActive(pool, owner, p.id, false);
    expect((await listPublicProducts(pool, slug))?.products.some((x) => x.id === p.id)).toBe(false);
    expect(await code(requestRental(pool, slug, p.id, guest({ startDate: "2035-10-10", endDate: "2035-10-10" }), opts))).toBe("not_found");
    // Katalog tidak boleh dimatikan selagi masih ada pesanan yang menahan unit.
    expect(await code(setFeatures(pool, owner, { ...DEFAULT_FEATURES, sewa: false }))).toBe("invalid_input");
    await pool.query(`UPDATE reservations SET status = 'cancelled' WHERE workspace_id = $1`, [wsId]);
    await setFeatures(pool, owner, { ...DEFAULT_FEATURES, sewa: false });
    expect(await listPublicProducts(pool, slug)).toBeNull();
    expect(await code(listProducts(pool, owner))).toBe("feature_disabled");
    expect(await code(requestRental(pool, slug, productId, guest({ startDate: "2035-10-10", endDate: "2035-10-10" }), opts))).toBe("not_found");
    await setFeatures(pool, owner, { ...DEFAULT_FEATURES, sewa: true });
  });

  it("pembatas laju: satu email tidak bisa menyapu banyak pesanan", async () => {
    const e = `spam-${sfx}@rt.local`;
    const results: string[] = [];
    for (let i = 0; i < 7; i++) results.push(await code(requestRental(pool, slug, productId, guest({ email: e, startDate: `2035-11-${String(10 + i).padStart(2, "0")}`, endDate: `2035-11-${String(10 + i).padStart(2, "0")}` }), opts)));
    expect(results.filter((r) => r === "ok").length).toBe(5);
    expect(results.slice(5)).toEqual(["rate_limited", "rate_limited"]);
  });

  it("foto produk: tersaji ke tamu lewat URL bertanda tangan hanya untuk produk aktif; berkas bukan gambar ditolak", async () => {
    const fileId = (await pool.query(`INSERT INTO files (workspace_id, storage_key, filename, mime, size_bytes, status) VALUES ($1, $2, 'motor.png', 'image/png', 100, 'ready') RETURNING id`, [wsId, `k-${sfx}`])).rows[0].id as string;
    const pdfId = (await pool.query(`INSERT INTO files (workspace_id, storage_key, filename, mime, size_bytes, status) VALUES ($1, $2, 'a.pdf', 'application/pdf', 100, 'ready') RETURNING id`, [wsId, `p-${sfx}`])).rows[0].id as string;
    expect(await code(createProduct(pool, owner, { name: "Bukan gambar", pricePerDayIdr: 1000, units: 1, imageFileId: pdfId }))).toBe("invalid_input");
    const p = await createProduct(pool, owner, { name: "Dengan Foto", pricePerDayIdr: 1000, units: 1, imageFileId: fileId });
    const storage = { presignDownload: async (i: { key: string }) => `http://s3.test/${i.key}` } as never;
    expect(await getProductImageUrl(pool, storage, slug, p.id)).toBe(`http://s3.test/k-${sfx}`);
    expect(await getProductImageUrl(pool, storage, slug, productId)).toBeNull(); // produk tanpa foto
    await setProductActive(pool, owner, p.id, false);
    expect(await getProductImageUrl(pool, storage, slug, p.id)).toBeNull(); // nonaktif tak tersaji
    // tamu tidak bisa membaca berkas lain (mis. PDF internal) lewat RLS
    const rows = await withTenant(pool, { userId: "00000000-0000-0000-0000-000000000000", workspaceId: wsId, actor: "public" }, (db) => db.execute<{ id: string }>(sql`SELECT id FROM files`));
    expect(rows.rows.some((r) => r.id === pdfId)).toBe(false);
  });

  it("DP sewa: tanpa metode bayar ditolak sebelum menahan unit; dengan DP unit ditahan, tidak bisa dikonfirmasi manual, lunas → terkonfirmasi; batal membatalkan tagihan; HP wajib", async () => {
    const dpProduct = (await createProduct(pool, owner, { name: "Mobil DP", pricePerDayIdr: 400000, depositIdr: 1000000, dpPercent: 30, units: 1 })).id;
    const deps = (): PaymentDeps => ({ pool, provider: new ManualProvider(), now: () => NOW, hooks: bookingPaymentHooks({ baseUrl: "http://t.local" }) });
    const stat = async (id: string) => (await pool.query(`SELECT r.status AS rs, p.status AS ps, p.amount_idr FROM reservations r LEFT JOIN payments p ON p.subject_id = r.id AND p.subject_type = 'reservation' WHERE r.id = (SELECT reservation_id FROM rental_orders WHERE id = $1)`, [id])).rows[0] as { rs: string; ps: string | null; amount_idr: string | null };

    // Tanpa metode pembayaran aktif: gagal tertutup, unit tidak tertahan.
    expect(await code(requestRental(pool, slug, dpProduct, guest({ startDate: "2035-04-10", endDate: "2035-04-11" }), opts))).toBe("payment_unavailable");
    expect((await getProductAvailability(pool, slug, dpProduct, { fromDate: "2035-04-10", count: 2, now: NOW })).every((d) => d.available)).toBe(true);
    await savePaymentMethod(pool, owner, { kind: "bank_transfer", label: "BCA", accountName: "Rental Uji", accountNumber: "1234567890" });

    // Pesanan 2 hari = Rp800.000; DP 30% = Rp240.000; unit tertahan (pending) dan tagihan DP terbuka.
    const a = await requestRental(pool, slug, dpProduct, guest({ startDate: "2035-04-10", endDate: "2035-04-11" }), opts);
    expect(a.dpIdr).toBe(240000);
    expect(await stat(a.orderId)).toMatchObject({ rs: "pending", ps: "pending", amount_idr: "240000" });
    expect(await code(requestRental(pool, slug, dpProduct, guest({ startDate: "2035-04-11", endDate: "2035-04-12" }), opts))).toBe("slot_unavailable");
    expect((await getRentalByToken(pool, a.token))?.dpIdr).toBe(240000);
    // Pelanggan melihat tagihan DP + metode bayar lewat tokennya (RLS reservasi).
    const view = await getManualPaymentView(pool, undefined, a.token);
    expect(view?.payment).toMatchObject({ status: "pending", amountIdr: 240000 });
    expect(view?.methods.map((m) => m.label)).toEqual(["BCA"]);
    expect(view?.canUpload).toBe(true);

    // Pemilik tidak boleh mengonfirmasi lewat tombol biasa selagi DP terbuka; verifikasi DP → terkonfirmasi.
    expect(await code(setOrderStatus(pool, owner, a.orderId, "confirmed", { baseUrl: "http://t.local" }))).toBe("invalid_input");
    const payId = (await pool.query(`SELECT id FROM payments WHERE subject_id = (SELECT reservation_id FROM rental_orders WHERE id = $1)`, [a.orderId])).rows[0].id as string;
    const r = await reviewPayment(deps(), owner, payId, { accept: true });
    expect(r.lateBooking).toBe(false);
    expect(await stat(a.orderId)).toMatchObject({ rs: "confirmed", ps: "paid" });

    // Pelanggan membatalkan sebelum bayar: tagihan ikut dibatalkan dan unit bebas.
    const b = await requestRental(pool, slug, dpProduct, guest({ startDate: "2035-04-20", endDate: "2035-04-20" }), opts);
    await cancelRentalByToken(pool, b.token, opts);
    expect(await stat(b.orderId)).toMatchObject({ rs: "cancelled", ps: "cancelled" });

    // Pemilik menolak pesanan ber-DP: tagihan dibatalkan juga.
    const c = await requestRental(pool, slug, dpProduct, guest({ startDate: "2035-04-25", endDate: "2035-04-26" }), opts);
    await setOrderStatus(pool, owner, c.orderId, "rejected", { baseUrl: "http://t.local" });
    expect(await stat(c.orderId)).toMatchObject({ rs: "rejected", ps: "cancelled" });

    // DP 0% = alur lama (tanpa tagihan). HP wajib untuk sewa.
    const free = (await createProduct(pool, owner, { name: "Sepeda", pricePerDayIdr: 50000, units: 1 })).id;
    const d = await requestRental(pool, slug, free, guest({ startDate: "2035-05-01", endDate: "2035-05-01" }), opts);
    expect(d.dpIdr).toBe(0);
    expect((await stat(d.orderId)).ps).toBeNull();
    expect(await code(requestRental(pool, slug, free, guest({ phone: "", startDate: "2035-05-03", endDate: "2035-05-03" }), opts))).toBe("invalid_input");

    // Mematikan pembayaran ditolak selama ada produk aktif ber-DP.
    expect(await code(setFeatures(pool, owner, { ...DEFAULT_FEATURES, sewa: true, pembayaran: false }))).toBe("invalid_input");
  });
});
void withWorkspace;