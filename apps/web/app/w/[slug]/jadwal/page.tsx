import {
  AppError,
  getWeeklyAvailability,
  listAvailableSlots,
  listMeetingTypeHosts,
  listMeetingTypes,
  listMembers,
  listMyWorkspaces,
  listOverrides,
  listPaymentMethods,
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
  updateMeetingTypeAction,
} from "@/lib/actions";
import { CopyButton } from "@/components/copy-button";
import { FeatureOff } from "@/components/feature-off";
import { MoneyField } from "@/components/money-input";
import { setHostsAction } from "@/lib/booking-actions";
import { fmtIdr } from "@/lib/format";
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
  searchParams: Promise<{ error?: string; type?: string; tersimpan?: string }>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, type, tersimpan } = await searchParams;
  const actor = { userId: user.id, slug };
  const pool = getPool();

  const mine = (await listMyWorkspaces(pool, user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  const features = mine.features;
  const tz = mine.timezone as WorkspaceTimezone;
  const canManageTypes = mine.role === "owner" || mine.role === "admin";
  if (!features.jadwal) return <FeatureOff feature="jadwal" slug={slug} canManage={canManageTypes} />;

  const [rules, overrides, types, hosts, members] = await Promise.all([
    getWeeklyAvailability(pool, actor),
    listOverrides(pool, actor),
    listMeetingTypes(pool, actor),
    listMeetingTypeHosts(pool, actor),
    listMembers(pool, actor),
  ]);
  const byDay = new Map(rules.map((r) => [r.weekday, r]));
  // Layanan ber-DP baru bisa dipesan bila ada minimal satu metode bayar aktif.
  const depositTypes = features.pembayaran ? types.filter((t) => t.active && t.depositIdr > 0) : [];
  const noMethod = depositTypes.length > 0 && (await listPaymentMethods(pool, actor)).every((m) => !m.active);

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
      <header className="page-head">
        <div>
          <h1>Jadwal &amp; layanan</h1>
          <p>Atur kapan Anda tersedia dan apa saja yang bisa dipesan. Semua jam dalam {TZ_LABEL[tz]} ({tz}).</p>
        </div>
      </header>
      <nav className="chips" aria-label="Loncat ke bagian">
        <a href="#jam">Jam kerja</a><a href="#layanan">Layanan</a><a href="#pengecualian">Libur &amp; pengecualian</a><a href="#pratinjau">Pratinjau slot</a>
      </nav>
      {error && <p className="error" role="alert">{error}</p>}
      {tersimpan && <p className="notice ok" role="status">Perubahan tersimpan.</p>}
      {noMethod && <p className="notice warn" role="alert"><b>Layanan berDP belum bisa dipesan.</b> {depositTypes.map((t) => t.title).join(", ")} meminta DP, tetapi belum ada metode pembayaran aktif. <Link href={`/w/${slug}/pembayaran#metode`}>Tambah metode pembayaran →</Link></p>}

      <section className="panel" id="jam">
        <div className="panel-head"><h2>Jam kerja mingguan</h2><p>Nyalakan hari Anda buka, lalu atur jamnya.</p></div>
        <form action={saveWeeklyAction.bind(null, slug)}>
          <div className="week">
            {DAYS.map(([d, name]) => (
              <div className="week-row" key={d}>
                <label className="switch">
                  <input type="checkbox" name={`on-${d}`} defaultChecked={byDay.has(d)} />
                  <span className="track" aria-hidden="true" />
                  <span className="day">{name}</span>
                </label>
                <span className="times">
                  <input type="time" name={`start-${d}`} defaultValue={byDay.get(d)?.start ?? "09:00"} aria-label={`${name} mulai`} />
                  <span aria-hidden="true">–</span>
                  <input type="time" name={`end-${d}`} defaultValue={byDay.get(d)?.end ?? "17:00"} aria-label={`${name} selesai`} />
                </span>
              </div>
            ))}
          </div>
          <button>Simpan jam kerja</button>
        </form>
      </section>

      <section className="panel" id="layanan">
        <div className="panel-head"><h2>Layanan yang bisa dipesan</h2><p>Tiap layanan punya link booking sendiri.</p></div>
        {types.length === 0 && <p>Belum ada layanan. Tambahkan yang pertama di bawah.</p>}
        <div className="svc-list">
          {types.map((t) => {
            const hostIds = new Set(hosts.filter((h) => h.meetingTypeId === t.id).map((h) => h.memberId));
            return (
              <article className={`svc${t.active ? "" : " off"}`} key={t.id}>
                <div className="svc-top">
                  <div>
                    <strong>{t.title}</strong>
                    <div className="svc-meta">
                      <span className="badge">{t.durationMin} menit</span>
                      <span className="badge">{t.depositIdr > 0 ? `DP ${fmtIdr(t.depositIdr)}` : "Gratis"}</span>
                      <span className={`badge ${t.active ? "ok" : ""}`}>{t.active ? "Aktif" : "Nonaktif"}</span>
                    </div>
                  </div>
                  {canManageTypes && (
                    <form action={toggleMeetingTypeAction.bind(null, slug, t.id, !t.active)} style={{ margin: 0 }}>
                      <button className="link">{t.active ? "Nonaktifkan" : "Aktifkan"}</button>
                    </form>
                  )}
                </div>
                <div className="svc-link">
                  <a href={`/${slug}/${t.slug}`} target="_blank" rel="noopener">jadwalin.id/{slug}/{t.slug}</a>
                  <CopyButton text={`/${slug}/${t.slug}`} label="Salin" />
                </div>
                {hostIds.size === 0 && <p className="notice warn">Belum ada yang melayani layanan ini, jadi disembunyikan dari halaman publik. Centang nama di bawah.</p>}
                {canManageTypes && (
                  <details className="fold slim">
                    <summary>Ubah nama, durasi, harga</summary>
                    <form action={updateMeetingTypeAction.bind(null, slug, t.id)}>
                      <label>Nama layanan<input name="title" required minLength={2} maxLength={80} defaultValue={t.title} /></label>
                      <div className="two">
                        <label>Durasi (menit)<input name="durationMin" type="number" required min={5} max={480} defaultValue={t.durationMin} /></label>
                        {features.pembayaran
                          ? <label>DP (kosongkan bila gratis)<MoneyField name="depositIdr" defaultValue={t.depositIdr} placeholder="0 = gratis" /></label>
                          : <label>DP<input disabled value="Fitur pembayaran dimatikan" /></label>}
                      </div>
                      <div className="two">
                        <label>Lokasi
                          <select name="locationKind" defaultValue={t.locationKind}><option value="link">Link online</option><option value="phone">Telepon</option><option value="in_person">Tatap muka</option></select>
                        </label>
                        <label>Link / nomor / alamat<input name="locationValue" defaultValue={t.locationValue ?? ""} /></label>
                      </div>
                      <button>Simpan perubahan</button>
                    </form>
                  </details>
                )}
                {canManageTypes && (
                  <details className="fold slim" open={hostIds.size === 0}>
                    <summary>Siapa yang melayani ({hostIds.size})</summary>
                    <form action={setHostsAction.bind(null, slug, t.id)}>
                      {members.map((m) => (
                        <label key={m.id} className="check-row">
                          <input type="checkbox" name="host" value={m.id} defaultChecked={hostIds.has(m.id)} /> {m.name}
                        </label>
                      ))}
                      <button>Simpan</button>
                    </form>
                  </details>
                )}
              </article>
            );
          })}
        </div>
        {canManageTypes && (
          <details className="fold">
            <summary>+ Tambah layanan baru</summary>
            <form action={createMeetingTypeAction.bind(null, slug)}>
              <div className="two">
                <label>Nama layanan<input name="title" required minLength={2} maxLength={80} placeholder="Konsultasi 30 menit" /></label>
                <label>Kode untuk link<input name="code" required pattern="[a-z0-9\-]{2,40}" placeholder="konsultasi" /></label>
              </div>
              <div className="two">
                <label>Durasi (menit)<input name="durationMin" type="number" required min={5} max={480} defaultValue={30} /></label>
                {features.pembayaran && <label>DP / biaya booking (kosongkan bila gratis)<MoneyField name="depositIdr" placeholder="0 = gratis" /></label>}
              </div>
              <div className="two">
                <label>Lokasi
                  <select name="locationKind"><option value="link">Link online</option><option value="phone">Telepon</option><option value="in_person">Tatap muka</option></select>
                </label>
                <label>Link / nomor / alamat<input name="locationValue" placeholder="https://meet.google.com/…" /></label>
              </div>
              <details className="fold slim">
                <summary>Pengaturan lanjutan</summary>
                <div className="two">
                  <label>Interval slot (menit)<input name="slotStepMin" type="number" min={5} max={240} defaultValue={30} /></label>
                  <label>Pemberitahuan minimum (menit)<input name="minNoticeMin" type="number" min={0} defaultValue={60} /></label>
                  <label>Jeda sebelum (menit)<input name="bufferBeforeMin" type="number" min={0} max={120} defaultValue={0} /></label>
                  <label>Jeda sesudah (menit)<input name="bufferAfterMin" type="number" min={0} max={120} defaultValue={0} /></label>
                </div>
                <label>Bisa dipesan sampai (hari ke depan)<input name="maxDaysAhead" type="number" min={1} max={365} defaultValue={30} /></label>
                <small>Jeda menempel pada tiap pertemuan: jarak dua pertemuan = jeda sesudah yang pertama + jeda sebelum yang kedua.</small>
              </details>
              <button>Tambah layanan</button>
            </form>
          </details>
        )}
      </section>

      <section className="panel" id="pengecualian">
        <div className="panel-head"><h2>Libur &amp; pengecualian tanggal</h2><p>Cuti, libur, atau jam tambahan di tanggal tertentu. Kosongkan jam untuk memblokir seharian.</p></div>
        {overrides.length === 0 && <small>Belum ada pengecualian.</small>}
        <div className="list">
          {overrides.map((o) => (
            <div className="list-row" key={o.id}>
              <span className="grow"><strong>{o.date}</strong><small>{o.kind === "blocked" ? "Tidak tersedia" : "Jam tambahan"} · {o.startTime ? `${o.startTime.slice(0, 5)}–${o.endTime?.slice(0, 5)}` : "seharian"}</small></span>
              <form action={removeOverrideAction.bind(null, slug, o.id)}><button className="link">Hapus</button></form>
            </div>
          ))}
        </div>
        <details className="fold">
          <summary>+ Tambah pengecualian</summary>
          <form action={addOverrideAction.bind(null, slug)}>
            <div className="two">
              <label>Tanggal<input type="date" name="date" required /></label>
              <label>Jenis<select name="kind"><option value="blocked">Tidak tersedia</option><option value="extra">Jam tambahan</option></select></label>
              <label>Jam mulai (kosong = seharian)<input type="time" name="start" /></label>
              <label>Jam selesai<input type="time" name="end" /></label>
            </div>
            <button>Tambah pengecualian</button>
          </form>
        </details>
      </section>

      <section className="panel" id="pratinjau">
        <div className="panel-head"><h2>Pratinjau slot tersedia</h2><p>Begini jam yang dilihat pelanggan (jadwal Anda sendiri).</p></div>
        {activeTypes.length > 1 && (
          <nav className="chips" aria-label="Pilih layanan">
            {activeTypes.map((t) => <Link key={t.id} href={`/w/${slug}/jadwal?type=${t.id}#pratinjau`} className={t.id === previewType?.id ? "on" : ""}>{t.title}</Link>)}
          </nav>
        )}
        {!previewType && <p>Buat layanan untuk melihat slot.</p>}
        {previewType && (
          <>
            {grouped.size === 0 && <p>Belum ada slot. Nyalakan hari dan atur jam kerja di atas.</p>}
            <div className="slot-days">
              {[...grouped.entries()].slice(0, 10).map(([day, times]) => (
                <div className="slot-day" key={day}>
                  <strong>{day}</strong>
                  <span className="slot-times">{times.map((t) => <span className="chip-static" key={t}>{t}</span>)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
