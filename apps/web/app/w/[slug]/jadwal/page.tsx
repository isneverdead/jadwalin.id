import {
  AppError,
  getWeeklyAvailability,
  listAvailableSlots,
  listMeetingTypeHosts,
  listMeetingTypes,
  listMembers,
  listMyWorkspaces,
  listOverrides,
  type WorkspaceTimezone,
} from "@jadwalin/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addOverrideAction,
  createMeetingTypeAction,
  removeOverrideAction,
  saveWeeklyAction,
  toggleMeetingTypeAction,
} from "@/lib/actions";
import { setHostsAction } from "@/lib/booking-actions";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Urutan tampil Senin–Minggu; angka = weekday (0 = Minggu).
const DAYS: [number, string][] = [[1, "Senin"], [2, "Selasa"], [3, "Rabu"], [4, "Kamis"], [5, "Jumat"], [6, "Sabtu"], [0, "Minggu"]];
const TZ_LABEL: Record<WorkspaceTimezone, string> = { "Asia/Jakarta": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" };

export default async function JadwalPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; type?: string }>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, type } = await searchParams;
  const actor = { userId: user.id, slug };
  const pool = getPool();

  const mine = (await listMyWorkspaces(pool, user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  const tz = mine.timezone as WorkspaceTimezone;
  const canManageTypes = mine.role === "owner" || mine.role === "admin";

  const [rules, overrides, types, hosts, members] = await Promise.all([
    getWeeklyAvailability(pool, actor),
    listOverrides(pool, actor),
    listMeetingTypes(pool, actor),
    listMeetingTypeHosts(pool, actor),
    listMembers(pool, actor),
  ]);
  const byDay = new Map(rules.map((r) => [r.weekday, r]));

  const activeTypes = types.filter((t) => t.active);
  const previewType = activeTypes.find((t) => t.id === type) ?? activeTypes[0];
  const slots = previewType
    ? await listAvailableSlots(pool, actor, { meetingTypeId: previewType.id }).catch((e) => {
        if (e instanceof AppError) return [];
        throw e;
      })
    : [];
  const dayFmt = new Intl.DateTimeFormat("id-ID", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  const timeFmt = new Intl.DateTimeFormat("id-ID", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const grouped = new Map<string, string[]>();
  for (const s of slots) {
    const key = dayFmt.format(s.start);
    grouped.set(key, [...(grouped.get(key) ?? []), timeFmt.format(s.start).replace(".", ":")]);
  }

  return (
    <>
      <p><Link href={`/w/${slug}`}>← {mine.name}</Link></p>
      <h1>Jadwal &amp; ketersediaan</h1>
      <small>Semua jam dalam {TZ_LABEL[tz]} ({tz}).</small>
      {error && <p className="error" role="alert">{error}</p>}

      <h2>Jam rutin mingguan Anda</h2>
      <form action={saveWeeklyAction.bind(null, slug)}>
        {DAYS.map(([d, name]) => (
          <div className="card" key={d}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" name={`on-${d}`} defaultChecked={byDay.has(d)} style={{ width: 18, height: 18 }} /> {name}
            </label>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="time" name={`start-${d}`} defaultValue={byDay.get(d)?.start ?? "09:00"} aria-label={`${name} mulai`} />
              –
              <input type="time" name={`end-${d}`} defaultValue={byDay.get(d)?.end ?? "17:00"} aria-label={`${name} selesai`} />
            </span>
          </div>
        ))}
        <button>Simpan jam rutin</button>
      </form>

      <h2>Pengecualian tanggal</h2>
      <p>Libur, cuti, atau jam tambahan di tanggal tertentu. Kosongkan jam untuk memblokir seharian.</p>
      {overrides.length === 0 && <small>Belum ada pengecualian.</small>}
      {overrides.map((o) => (
        <div className="card" key={o.id}>
          <span>
            {o.date} · {o.kind === "blocked" ? "Tidak tersedia" : "Jam tambahan"}{" "}
            <small>{o.startTime ? `${o.startTime.slice(0, 5)}–${o.endTime?.slice(0, 5)}` : "seharian"}</small>
          </span>
          <form action={removeOverrideAction.bind(null, slug, o.id)}><button className="link">Hapus</button></form>
        </div>
      ))}
      <form action={addOverrideAction.bind(null, slug)}>
        <label>Tanggal<input type="date" name="date" required /></label>
        <label>Jenis<select name="kind"><option value="blocked">Tidak tersedia</option><option value="extra">Jam tambahan</option></select></label>
        <label>Jam mulai (opsional untuk blokir)<input type="time" name="start" /></label>
        <label>Jam selesai<input type="time" name="end" /></label>
        <button>Tambah pengecualian</button>
      </form>

      <h2>Jenis pertemuan</h2>
      {types.length === 0 && <p>Belum ada jenis pertemuan.</p>}
      {types.map((t) => {
        const hostIds = new Set(hosts.filter((h) => h.meetingTypeId === t.id).map((h) => h.memberId));
        return (
          <div className="card" key={t.id} style={{ display: "block" }}>
            <div className="row">
              <span>{t.title} <small>{t.durationMin} menit · {t.active ? "aktif" : "nonaktif"}</small></span>
              {canManageTypes && (
                <form action={toggleMeetingTypeAction.bind(null, slug, t.id, !t.active)} style={{ margin: 0 }}>
                  <button className="link">{t.active ? "Nonaktifkan" : "Aktifkan"}</button>
                </form>
              )}
            </div>
            <small>Link booking: <a href={`/${slug}/${t.slug}`}>jadwalin.id/{slug}/{t.slug}</a>{hostIds.size === 0 ? " — BELUM ADA HOST: halaman publik menyembunyikan jenis ini" : ""}</small>
            {canManageTypes && (
              <form action={setHostsAction.bind(null, slug, t.id)} style={{ margin: "8px 0 0" }}>
                <small>Yang melayani pemesanan (slot gabungan kalender mereka):</small>
                {members.map((m) => (
                  <label key={m.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" name="host" value={m.id} defaultChecked={hostIds.has(m.id)} style={{ width: 18, height: 18 }} /> {m.name}
                  </label>
                ))}
                <button className="link" style={{ justifySelf: "start" }}>Simpan host</button>
              </form>
            )}
          </div>
        );
      })}
      {canManageTypes && (
        <>
          <h3>Tambah jenis pertemuan</h3>
          <form action={createMeetingTypeAction.bind(null, slug)}>
            <label>Judul<input name="title" required minLength={2} maxLength={80} placeholder="Konsultasi 30 menit" /></label>
            <label>Kode (untuk link)<input name="code" required pattern="[a-z0-9-]{2,40}" placeholder="konsultasi" /></label>
            <label>Durasi (menit)<input name="durationMin" type="number" required min={5} max={480} defaultValue={30} /></label>
            <label>Interval slot (menit)<input name="slotStepMin" type="number" min={5} max={240} defaultValue={30} /></label>
            <label>
              Buffer sebelum (menit)<input name="bufferBeforeMin" type="number" min={0} max={120} defaultValue={0} />
            </label>
            <label>
              Buffer sesudah (menit)<input name="bufferAfterMin" type="number" min={0} max={120} defaultValue={0} />
            </label>
            <small>Buffer menempel pada tiap pertemuan, jadi jarak antar dua pertemuan = buffer sesudah yang pertama + buffer sebelum yang kedua.</small>
            <label>Pemberitahuan minimum (menit)<input name="minNoticeMin" type="number" min={0} defaultValue={60} /></label>
            <label>Bisa dipesan sampai (hari ke depan)<input name="maxDaysAhead" type="number" min={1} max={365} defaultValue={30} /></label>
            <label>
              Lokasi
              <select name="locationKind"><option value="link">Link online</option><option value="phone">Telepon</option><option value="in_person">Tatap muka</option></select>
            </label>
            <label>DP / biaya booking (Rupiah, kosongkan bila gratis)<input name="depositIdr" type="number" min={0} step={1000} placeholder="0" /></label>
            <label>Link / nomor / alamat<input name="locationValue" placeholder="https://meet.google.com/…" /></label>
            <button>Tambah jenis pertemuan</button>
          </form>
        </>
      )}

      <h2>Pratinjau slot tersedia</h2>
      {activeTypes.length > 1 && (
        <p>
          {activeTypes.map((t) => (
            <span key={t.id}>
              <Link href={`/w/${slug}/jadwal?type=${t.id}`}>{t.title}</Link>{" "}
            </span>
          ))}
        </p>
      )}
      {!previewType && <p>Buat jenis pertemuan untuk melihat slot.</p>}
      {previewType && (
        <>
          <small>Untuk “{previewType.title}” (jadwal Anda sendiri).</small>
          {grouped.size === 0 && <p>Belum ada slot. Atur jam rutin Anda di atas.</p>}
          {[...grouped.entries()].slice(0, 10).map(([day, times]) => (
            <div className="card" key={day}>
              <strong>{day}</strong>
              <span>{times.join("  ")}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
