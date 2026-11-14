import type pg from "pg";
import { AppError } from "./errors";
import { createMeetingType, setWeeklyAvailability, type MeetingTypeInput } from "./scheduling";
import { DEFAULT_FEATURES, type Features } from "./features";
import type { WeeklyRule } from "./slots";
import type { Actor } from "./workspace";

/**
 * Template bisnis untuk alur onboarding: jenis pertemuan, jam kerja, dan langkah berikutnya yang
 * disesuaikan dengan bidang pengguna. Murni data (tanpa baca DB/jam sistem); harga/DP hanya titik awal
 * yang bisa diubah pemilik, bukan saran harga pasar.
 */
export interface BusinessTemplate {
  id: string;
  /** Nama yang dikenali orang awam. */
  name: string;
  group: "Kesehatan" | "Kecantikan & perawatan" | "Belajar & kebugaran" | "Jasa profesional" | "Kreatif & acara" | "Kendaraan & sewa" | "Rental barang" | "Lainnya";
  tagline: string;
  /** Contoh nama bisnis untuk placeholder form. */
  example: string;
  availability: WeeklyRule[];
  /** 'sewa' = katalog barang yang disewa per hari (tanpa janji temu): layanan/jam kerja kosong, produk contoh terisi. */
  kind: "jadwal" | "sewa";
  /** Produk contoh untuk template sewa (bisa diubah/diganti pemilik). */
  products: { name: string; category: string; description: string; pricePerDayIdr: number; depositIdr: number; /** DP persen dari total sewa (0 = tanpa DP). */ dpPercent?: number; units: number }[];
  meetingTypes: Pick<MeetingTypeInput, "slug" | "title" | "durationMin" | "slotStepMin" | "bufferAfterMin" | "locationKind" | "depositIdr">[];
  /** Langkah berikutnya khusus bidang ini (tampil di Ringkasan setelah halaman dibuat). */
  nextSteps: string[];
  /** Fitur yang disarankan menyala untuk bidang ini; pemilik bisa mengubahnya saat membuat halaman atau nanti di Pengaturan. */
  features: Features;
  /** Alasan singkat di balik saran fitur (ditampilkan di form). */
  featureWhy: string;
  /** true = dipakai perorangan (praktik pribadi/freelance): kolom nama berbunyi "Nama Anda atau nama praktik", bukan "usaha". */
  personal: boolean;
  /** Label kolom nama di form pembuatan, sesuai jenis (pribadi / tempat / netral). */
  nameLabel: string;
}

const days = (list: number[], start: string, end: string): WeeklyRule[] => list.map((weekday) => ({ weekday, start, end }));
const SENIN_JUMAT = [1, 2, 3, 4, 5];
const SENIN_SABTU = [1, 2, 3, 4, 5, 6];
const SELASA_MINGGU = [2, 3, 4, 5, 6, 0];
const SEMUA_HARI = [0, 1, 2, 3, 4, 5, 6];

const mt = (slug: string, title: string, durationMin: number, o: { dp?: number; where?: "link" | "in_person" | "phone"; buffer?: number; step?: number } = {}): BusinessTemplate["meetingTypes"][number] => ({
  slug,
  title,
  durationMin,
  slotStepMin: o.step ?? (durationMin >= 60 ? 60 : durationMin >= 30 ? 30 : 15),
  bufferAfterMin: o.buffer ?? 0,
  locationKind: o.where ?? "in_person",
  depositIdr: o.dp ?? 0,
});

const STEP_BAYAR = "Atur metode pembayaran (rekening/QRIS) di menu Pembayaran agar pelanggan bisa membayar DP";
const STEP_ALAMAT = "Isi alamat atau lokasi di tiap jenis pertemuan";
const STEP_LINK = "Isi link meeting (Google Meet/Zoom) di tiap jenis pertemuan online";
const STEP_BAGIKAN = "Bagikan link halaman booking Anda ke Instagram, WhatsApp, atau kartu nama";

type RawTemplate = Omit<BusinessTemplate, "features" | "featureWhy" | "personal" | "nameLabel" | "kind" | "products"> & { kind?: "jadwal" | "sewa"; products?: BusinessTemplate["products"] };
const RAW_TEMPLATES: readonly RawTemplate[] = [
  // Kesehatan
  { id: "klinik-dokter", name: "Dokter / klinik umum", group: "Kesehatan", tagline: "Pasien memilih jam periksa tanpa antre telepon.", example: "Klinik Sehat Sentosa", availability: [...days(SENIN_JUMAT, "08:00", "12:00"), ...days(SENIN_JUMAT, "16:00", "20:00")], meetingTypes: [mt("konsultasi-umum", "Konsultasi dokter umum", 20, { step: 20 }), mt("kontrol-ulang", "Kontrol ulang", 15, { step: 15 })], nextSteps: ["Sesuaikan jam praktik pagi dan sore", STEP_ALAMAT, "Undang perawat/admin pendaftaran sebagai anggota", STEP_BAGIKAN] },
  { id: "dokter-gigi", name: "Dokter gigi", group: "Kesehatan", tagline: "Jadwal pemeriksaan dan tindakan yang rapi.", example: "Senyum Prima Dental", availability: days(SENIN_SABTU, "09:00", "17:00"), meetingTypes: [mt("pemeriksaan", "Pemeriksaan & konsultasi", 30), mt("scaling", "Pembersihan karang gigi", 60, { dp: 50000 }), mt("tambal", "Tambal gigi", 60, { dp: 50000 })], nextSteps: [STEP_BAYAR, "Sesuaikan durasi tindakan dengan kebiasaan praktik Anda", STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "psikolog", name: "Psikolog / konselor", group: "Kesehatan", tagline: "Sesi konseling tatap muka atau online dengan jeda antar klien.", example: "Ruang Tenang Konseling", availability: days(SENIN_SABTU, "10:00", "18:00"), meetingTypes: [mt("sesi-perkenalan", "Sesi perkenalan", 30, { where: "link" }), mt("sesi-konseling", "Sesi konseling", 60, { dp: 100000, buffer: 15, where: "link" })], nextSteps: [STEP_BAYAR, STEP_LINK, "Data kesehatan jiwa bersifat sensitif: pelajari halaman Privasi dan DPA sebelum dipakai klien", STEP_BAGIKAN] },
  { id: "fisioterapi", name: "Fisioterapi / terapi", group: "Kesehatan", tagline: "Asesmen awal dan terapi lanjutan.", example: "Sendi Sehat Fisioterapi", availability: days(SENIN_SABTU, "09:00", "18:00"), meetingTypes: [mt("asesmen-awal", "Asesmen awal", 60, { dp: 100000 }), mt("terapi-lanjutan", "Terapi lanjutan", 45, { step: 45, dp: 50000 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "ahli-gizi", name: "Ahli gizi", group: "Kesehatan", tagline: "Konsultasi gizi awal dan kontrol berkala.", example: "Gizi Seimbang", availability: days(SENIN_JUMAT, "09:00", "16:00"), meetingTypes: [mt("konsultasi-awal", "Konsultasi gizi awal", 45, { dp: 75000, where: "link", step: 45 }), mt("kontrol-gizi", "Kontrol gizi", 30, { where: "link" })], nextSteps: [STEP_BAYAR, STEP_LINK, STEP_BAGIKAN] },
  { id: "dokter-hewan", name: "Dokter hewan / pet grooming", group: "Kesehatan", tagline: "Pemeriksaan dan grooming hewan peliharaan.", example: "Klinik Hewan Sahabat", availability: days(SENIN_SABTU, "09:00", "18:00"), meetingTypes: [mt("periksa-hewan", "Pemeriksaan hewan", 30), mt("grooming", "Grooming", 90, { dp: 50000, step: 30 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, STEP_BAGIKAN] },

  // Kecantikan & perawatan
  { id: "salon", name: "Salon rambut", group: "Kecantikan & perawatan", tagline: "Pelanggan memilih layanan dan jam tanpa menunggu balasan chat.", example: "Salon Cantika", availability: days(SELASA_MINGGU, "10:00", "19:00"), meetingTypes: [mt("potong-rambut", "Potong rambut", 45, { step: 30 }), mt("creambath", "Creambath", 60), mt("pewarnaan", "Pewarnaan rambut", 120, { dp: 100000, step: 60 })], nextSteps: [STEP_BAYAR, "Sesuaikan durasi layanan dengan kecepatan tim Anda", STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "barbershop", name: "Barbershop", group: "Kecantikan & perawatan", tagline: "Antrean cukur yang jelas, tanpa nomor urut manual.", example: "Kang Cukur Barbershop", availability: days(SEMUA_HARI, "10:00", "21:00"), meetingTypes: [mt("potong", "Potong rambut", 30), mt("potong-jenggot", "Potong + rapikan jenggot", 45, { step: 15 })], nextSteps: ["Undang barber lain sebagai anggota dan atur jam masing-masing", STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "spa-pijat", name: "Spa / pijat", group: "Kecantikan & perawatan", tagline: "Sesi relaksasi dengan jeda pembersihan ruangan.", example: "Rileks Spa", availability: days(SEMUA_HARI, "10:00", "21:00"), meetingTypes: [mt("pijat-60", "Pijat 60 menit", 60, { dp: 50000, buffer: 15 }), mt("pijat-90", "Pijat 90 menit", 90, { dp: 75000, buffer: 15, step: 30 }), mt("refleksi", "Refleksi kaki", 45, { buffer: 15, step: 15 })], nextSteps: [STEP_BAYAR, "Undang terapis sebagai anggota agar jadwalnya terpisah", STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "kecantikan", name: "Kuku, bulu mata & facial", group: "Kecantikan & perawatan", tagline: "Perawatan kecantikan dengan DP untuk mengurangi pembatalan.", example: "Glow Beauty Studio", availability: days(SENIN_SABTU, "10:00", "19:00"), meetingTypes: [mt("nail-art", "Nail art", 90, { dp: 50000, step: 30 }), mt("eyelash", "Eyelash extension", 120, { dp: 75000, step: 60 }), mt("facial", "Facial", 60, { dp: 50000 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "makeup-artist", name: "Makeup artist (MUA)", group: "Kecantikan & perawatan", tagline: "Konsultasi dulu, lalu pesan sesi rias dengan DP.", example: "Rias oleh Dinda", availability: days(SEMUA_HARI, "06:00", "18:00"), meetingTypes: [mt("konsultasi-rias", "Konsultasi makeup", 30, { where: "link", step: 30 }), mt("makeup-pesta", "Makeup pesta/wisuda", 90, { dp: 100000, step: 30 }), mt("makeup-pengantin", "Makeup pengantin", 180, { dp: 500000, step: 60 })], nextSteps: [STEP_BAYAR, "Cek ulang jam mulai pagi untuk acara yang butuh rias subuh", STEP_BAGIKAN] },
  { id: "tato", name: "Studio tato / tindik", group: "Kecantikan & perawatan", tagline: "Konsultasi desain gratis, sesi panjang dengan DP.", example: "Tinta Studio", availability: days(SELASA_MINGGU, "12:00", "20:00"), meetingTypes: [mt("konsultasi-desain", "Konsultasi desain", 30, { where: "link" }), mt("sesi-tato", "Sesi tato", 180, { dp: 300000, step: 60 })], nextSteps: [STEP_BAYAR, "Tegaskan batas usia dan aturan kesehatan di deskripsi/pesan konfirmasi Anda", STEP_BAGIKAN] },

  // Belajar & kebugaran
  { id: "les-privat", name: "Guru les / bimbel", group: "Belajar & kebugaran", tagline: "Murid atau orang tua memilih jam les sendiri.", example: "Les Matematika Pak Andi", availability: [...days(SENIN_JUMAT, "15:00", "20:00"), ...days([6, 0], "09:00", "17:00")], meetingTypes: [mt("kelas-percobaan", "Kelas percobaan", 30, { where: "link" }), mt("les-privat", "Les privat", 60, { dp: 50000, where: "link" }), mt("les-intensif", "Les intensif", 90, { dp: 75000, where: "link", step: 30 })], nextSteps: [STEP_BAYAR, STEP_LINK, "Ubah jam ketersediaan sesuai jadwal mengajar Anda", STEP_BAGIKAN] },
  { id: "kursus-musik", name: "Kursus musik / bahasa", group: "Belajar & kebugaran", tagline: "Sesi kursus per pertemuan, tatap muka maupun online.", example: "Nada Kursus Musik", availability: days(SENIN_SABTU, "13:00", "20:00"), meetingTypes: [mt("kelas-perkenalan", "Kelas perkenalan", 30), mt("kursus-reguler", "Kursus reguler", 60, { dp: 50000 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "personal-trainer", name: "Personal trainer / pelatih", group: "Belajar & kebugaran", tagline: "Sesi latihan privat dan sesi percobaan.", example: "FitWithRaka", availability: [...days(SENIN_JUMAT, "06:00", "09:00"), ...days(SENIN_JUMAT, "17:00", "20:00"), ...days([6], "07:00", "12:00")], meetingTypes: [mt("sesi-percobaan", "Sesi percobaan", 30), mt("personal-training", "Personal training", 60, { dp: 50000 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "yoga-pilates", name: "Instruktur yoga / pilates", group: "Belajar & kebugaran", tagline: "Sesi privat atau semi-privat dengan jam yang pasti.", example: "Yoga Bersama Sinta", availability: [...days(SENIN_SABTU, "07:00", "10:00"), ...days(SENIN_JUMAT, "17:00", "20:00")], meetingTypes: [mt("kelas-privat", "Kelas privat", 60, { dp: 50000 }), mt("kelas-semi-privat", "Kelas semi-privat", 60, { dp: 75000 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, STEP_BAGIKAN] },

  // Jasa profesional
  { id: "konsultan", name: "Konsultan / coach", group: "Jasa profesional", tagline: "Konsultasi awal gratis, sesi lanjutan berbayar.", example: "Dewi Konsultasi Bisnis", availability: days(SENIN_JUMAT, "09:00", "17:00"), meetingTypes: [mt("konsultasi-awal", "Konsultasi awal (gratis)", 30, { where: "link" }), mt("sesi-konsultasi", "Sesi konsultasi", 60, { dp: 100000, where: "link", buffer: 15 })], nextSteps: [STEP_BAYAR, STEP_LINK, STEP_BAGIKAN] },
  { id: "hukum-pajak", name: "Konsultan hukum / pajak / akuntan", group: "Jasa profesional", tagline: "Konsultasi terjadwal dengan DP; dokumen klien lewat tiket dan berkas.", example: "Kantor Pajak Maju", availability: days(SENIN_JUMAT, "09:00", "16:00"), meetingTypes: [mt("konsultasi-awal", "Konsultasi awal", 30, { where: "link" }), mt("konsultasi-lanjutan", "Konsultasi lanjutan", 60, { dp: 150000, where: "link", buffer: 15 })], nextSteps: [STEP_BAYAR, STEP_LINK, "Gunakan menu Tiket untuk permintaan dokumen dan pertanyaan klien, dan Berkas untuk lampiran", STEP_BAGIKAN] },
  { id: "desainer-freelancer", name: "Desainer / freelancer", group: "Jasa profesional", tagline: "Diskusi proyek dan sesi revisi yang terjadwal.", example: "Studio Kreasi Lepas", availability: days(SENIN_JUMAT, "10:00", "17:00"), meetingTypes: [mt("diskusi-proyek", "Diskusi proyek", 30, { where: "link" }), mt("sesi-revisi", "Sesi revisi", 45, { where: "link", step: 15 })], nextSteps: [STEP_LINK, "Pakai menu Tiket agar permintaan klien tercatat", STEP_BAGIKAN] },
  { id: "demo-produk", name: "Demo produk / penjualan B2B", group: "Jasa profesional", tagline: "Calon pelanggan memilih jam demo sendiri.", example: "Aplikasi Kasir Pintar", availability: days(SENIN_JUMAT, "09:00", "17:00"), meetingTypes: [mt("demo-produk", "Demo produk", 30, { where: "link" }), mt("diskusi-kebutuhan", "Diskusi kebutuhan", 45, { where: "link", step: 15 })], nextSteps: [STEP_LINK, STEP_BAGIKAN] },

  // Kreatif & acara
  { id: "fotografer", name: "Fotografer / studio foto", group: "Kreatif & acara", tagline: "Konsultasi konsep lalu pesan sesi pemotretan dengan DP.", example: "Lensa Cerita Studio", availability: days(SEMUA_HARI, "09:00", "18:00"), meetingTypes: [mt("konsultasi-konsep", "Konsultasi konsep", 30, { where: "link" }), mt("sesi-foto", "Sesi pemotretan", 120, { dp: 250000, buffer: 30, step: 60 }), mt("sesi-prewedding", "Sesi prewedding", 240, { dp: 500000, buffer: 30, step: 60 })], nextSteps: [STEP_BAYAR, "Sesuaikan durasi dan DP dengan paket Anda", STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "wedding-event", name: "Wedding / event organizer", group: "Kreatif & acara", tagline: "Konsultasi gratis untuk calon klien, rapat teknis untuk klien tetap.", example: "Janji Suci Wedding Organizer", availability: days(SENIN_SABTU, "10:00", "17:00"), meetingTypes: [mt("konsultasi-gratis", "Konsultasi gratis", 45, { where: "link", step: 45 }), mt("rapat-teknis", "Rapat teknis acara", 60, { where: "link" })], nextSteps: [STEP_LINK, "Pakai menu Tiket dan Berkas untuk dokumen dan permintaan klien", STEP_BAGIKAN] },

  // Kendaraan & sewa
  { id: "bengkel", name: "Bengkel / servis kendaraan", group: "Kendaraan & sewa", tagline: "Pelanggan memilih jam servis, bengkel tahu bebannya.", example: "Bengkel Jaya Motor", availability: days(SENIN_SABTU, "08:00", "17:00"), meetingTypes: [mt("servis-berkala", "Servis berkala", 120, { step: 60 }), mt("cek-kendaraan", "Cek kendaraan", 30)], nextSteps: [STEP_ALAMAT, "Undang mekanik/teknisi sebagai anggota", STEP_BAGIKAN] },
  { id: "cuci-detailing", name: "Cuci kendaraan / detailing", group: "Kendaraan & sewa", tagline: "Slot cuci dan detailing yang tidak bentrok.", example: "Kilap Car Wash", availability: days(SEMUA_HARI, "08:00", "18:00"), meetingTypes: [mt("cuci-standar", "Cuci standar", 60), mt("detailing", "Detailing interior & eksterior", 240, { dp: 200000, step: 60 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, STEP_BAGIKAN] },
  { id: "sewa-lapangan", name: "Sewa lapangan / ruangan", group: "Kendaraan & sewa", tagline: "Booking per jam, bentrok jadwal dicegah otomatis.", example: "Lapangan Futsal Garuda", availability: days(SEMUA_HARI, "08:00", "23:00"), meetingTypes: [mt("sewa-1-jam", "Sewa 1 jam", 60, { dp: 50000 }), mt("sewa-2-jam", "Sewa 2 jam", 120, { dp: 100000, step: 60 })], nextSteps: [STEP_BAYAR, STEP_ALAMAT, "Sesuaikan jam buka dan harga DP", STEP_BAGIKAN] },

  // Rental barang
  { id: "rental-mobil", name: "Rental mobil", group: "Rental barang", kind: "sewa", tagline: "Pasang daftar mobil, pelanggan memilih tanggal; unit yang sama tidak mungkin tersewa ganda.", example: "Rental Mobil Jaya Abadi", availability: [], meetingTypes: [], products: [
      { name: "Toyota Avanza", category: "Mobil", description: "7 penumpang, AC, manual/matic. Lepas kunci atau dengan sopir (tanyakan pemilik).", pricePerDayIdr: 450000, depositIdr: 1000000, units: 2 },
      { name: "Daihatsu Xenia", category: "Mobil", description: "7 penumpang, irit, cocok untuk keluarga.", pricePerDayIdr: 400000, depositIdr: 1000000, units: 2 },
      { name: "Toyota Innova Reborn", category: "Mobil", description: "Nyaman untuk perjalanan jauh, 7 penumpang.", pricePerDayIdr: 750000, depositIdr: 2000000, units: 1 }], nextSteps: ["Ganti mobil contoh dengan armada Anda di menu Produk (nama, harga per hari, jumlah unit)", "Unggah foto tiap mobil agar pelanggan tertarik", "Konfirmasi atau tolak permintaan di menu Pesanan sewa", STEP_BAGIKAN] },
  { id: "rental-motor", name: "Rental motor / skuter", group: "Rental barang", kind: "sewa", tagline: "Daftar motor dengan jumlah unit; ketersediaan per tanggal otomatis.", example: "Rental Motor Bali Mudah", availability: [], meetingTypes: [], products: [
      { name: "Honda Beat", category: "Motor", description: "Matic irit, helm 2 buah termasuk.", pricePerDayIdr: 80000, depositIdr: 200000, units: 4 },
      { name: "Honda Vario 125", category: "Motor", description: "Matic nyaman untuk berdua, helm 2 buah termasuk.", pricePerDayIdr: 100000, depositIdr: 300000, units: 3 },
      { name: "Yamaha NMAX", category: "Motor", description: "Matic premium, bagasi luas.", pricePerDayIdr: 180000, depositIdr: 500000, units: 2 }], nextSteps: ["Ganti motor contoh dengan armada Anda di menu Produk", "Unggah foto tiap motor", "Konfirmasi pesanan di menu Pesanan sewa; tandai 'Barang diambil' dan 'Selesai' saat serah-terima", STEP_BAGIKAN] },
  { id: "sewa-kamera", name: "Sewa kamera & perlengkapan", group: "Rental barang", kind: "sewa", tagline: "Kamera, lensa, dan drone dengan jadwal sewa yang jelas.", example: "Lensa Sewa Studio", availability: [], meetingTypes: [], products: [
      { name: "Sony A7 III (body)", category: "Kamera", description: "Mirrorless full-frame, termasuk baterai cadangan dan SD card.", pricePerDayIdr: 350000, depositIdr: 1000000, units: 1 },
      { name: "Canon EOS 80D + lensa kit", category: "Kamera", description: "DSLR serbaguna untuk pemula.", pricePerDayIdr: 200000, depositIdr: 500000, units: 2 },
      { name: "Lensa 24-70mm f/2.8", category: "Lensa", description: "Lensa zoom standar profesional.", pricePerDayIdr: 150000, depositIdr: 500000, units: 1 }], nextSteps: ["Ganti perlengkapan contoh dengan inventaris Anda di menu Produk", "Unggah foto dan tulis kelengkapan paket di deskripsi", "Konfirmasi pesanan di menu Pesanan sewa", STEP_BAGIKAN] },
  { id: "sewa-alat-pesta", name: "Sewa alat pesta & acara", group: "Rental barang", kind: "sewa", tagline: "Tenda, kursi, sound system, dan dekorasi, jumlah unit per barang.", example: "Sewa Pesta Berkah", availability: [], meetingTypes: [], products: [
      { name: "Tenda 3x3 m", category: "Tenda", description: "Termasuk pemasangan di area kota (tanyakan biaya luar kota).", pricePerDayIdr: 100000, depositIdr: 200000, units: 10 },
      { name: "Kursi lipat", category: "Perabot", description: "Harga per kursi per hari.", pricePerDayIdr: 3000, depositIdr: 0, units: 50 },
      { name: "Sound system 1000 watt", category: "Audio", description: "Speaker, mixer, 2 mic; teknisi opsional.", pricePerDayIdr: 400000, depositIdr: 500000, units: 2 }], nextSteps: ["Ganti barang contoh dengan inventaris Anda di menu Produk (jumlah unit sampai 50 per barang)", "Unggah foto dan tulis aturan antar-jemput di deskripsi", "Konfirmasi pesanan di menu Pesanan sewa", STEP_BAGIKAN] },
  { id: "sewa-camping", name: "Sewa alat camping & outdoor", group: "Rental barang", kind: "sewa", tagline: "Tenda, carrier, dan perlengkapan pendakian per hari.", example: "Sewa Gunung Rimba", availability: [], meetingTypes: [], products: [
      { name: "Tenda dome 4 orang", category: "Tenda", description: "Double layer, termasuk flysheet dan pasak.", pricePerDayIdr: 75000, depositIdr: 100000, units: 3 },
      { name: "Carrier 60L", category: "Tas", description: "Dengan rain cover.", pricePerDayIdr: 40000, depositIdr: 100000, units: 4 },
      { name: "Sleeping bag", category: "Perlengkapan", description: "Hangat sampai sekitar 10 derajat Celsius.", pricePerDayIdr: 25000, depositIdr: 50000, units: 6 }], nextSteps: ["Ganti peralatan contoh dengan inventaris Anda di menu Produk", "Unggah foto tiap barang", "Konfirmasi pesanan di menu Pesanan sewa", STEP_BAGIKAN] },
  { id: "sewa-sepeda", name: "Sewa sepeda & skuter listrik", group: "Rental barang", kind: "sewa", tagline: "Sepeda wisata dan skuter listrik per hari.", example: "Sewa Sepeda Kota", availability: [], meetingTypes: [], products: [
      { name: "Sepeda gunung", category: "Sepeda", description: "Termasuk helm dan kunci.", pricePerDayIdr: 50000, depositIdr: 100000, units: 4 },
      { name: "Sepeda lipat", category: "Sepeda", description: "Ringan, cocok untuk keliling kota.", pricePerDayIdr: 60000, depositIdr: 150000, units: 3 },
      { name: "Skuter listrik", category: "Skuter", description: "Jarak tempuh sekitar 30 km per pengisian.", pricePerDayIdr: 150000, depositIdr: 500000, units: 2 }], nextSteps: ["Ganti armada contoh dengan milik Anda di menu Produk", "Unggah foto tiap unit", "Konfirmasi pesanan di menu Pesanan sewa", STEP_BAGIKAN] },

  // Lainnya
  { id: "kosong", name: "Mulai dari kosong", group: "Lainnya", tagline: "Tidak ada yang cocok? Atur jenis layanan dan jam sendiri.", example: "Nama halaman jadwal Anda", availability: days(SENIN_JUMAT, "09:00", "17:00"), meetingTypes: [mt("pertemuan", "Pertemuan", 30, { where: "link" })], nextSteps: ["Ubah nama dan durasi layanan di menu Jadwal", "Atur jam kerja", STEP_BAGIKAN] },
];

const F = (tiket: boolean, pembayaran: boolean, berkas: boolean, why: string, sewa = false): { features: Features; featureWhy: string } => ({ features: { jadwal: !sewa, tiket, pembayaran, berkas, sewa }, featureWhy: why });

/**
 * Hasil analisis kebutuhan tiap jenis usaha (tiket, DP, berkas). Prinsipnya: nyalakan hanya yang dipakai sehari-hari,
 * supaya menu tidak penuh fitur yang tidak relevan.
 */
const FEATURE_PRESETS: Record<string, { features: Features; featureWhy: string }> = {
  "klinik-dokter": F(false, false, true, "Pasien cukup memesan jam; biaya biasanya dibayar di klinik. Berkas untuk dokumen praktik. Tiket dimatikan agar pasien tidak mengirim keluhan medis lewat pesan."),
  "dokter-gigi": F(false, true, true, "DP mengurangi pasien yang tidak datang untuk tindakan. Berkas untuk formulir dan edukasi pasien."),
  "psikolog": F(false, true, false, "DP mengurangi pembatalan mendadak. Berkas dimatikan agar data sensitif tidak tersimpan di sistem."),
  "fisioterapi": F(false, true, true, "DP untuk asesmen awal; berkas untuk program latihan yang dibagikan."),
  "ahli-gizi": F(true, true, true, "Klien sering bertanya di antara sesi (tiket) dan butuh menerima program/menu (berkas)."),
  "dokter-hewan": F(false, true, false, "DP untuk grooming dan tindakan; pemilik hewan cukup memesan jadwal."),
  "salon": F(false, true, false, "Pelanggan cukup memesan layanan; DP untuk perawatan panjang seperti pewarnaan."),
  "barbershop": F(false, false, false, "Antrean cukur sederhana: pesan jam lalu datang, bayar di tempat."),
  "spa-pijat": F(false, true, false, "DP mengurangi jadwal kosong karena batal; tidak perlu tiket atau berkas."),
  "kecantikan": F(false, true, false, "DP untuk perawatan berdurasi panjang; tidak perlu tiket."),
  "makeup-artist": F(true, true, true, "Klien butuh berdiskusi detail acara (tiket) dan mengirim foto referensi (berkas); DP mengunci tanggal."),
  "tato": F(false, true, true, "DP untuk sesi panjang; berkas untuk desain/referensi dan persetujuan."),
  "les-privat": F(true, true, true, "Murid/orang tua bertanya dan menerima materi/PR; DP untuk sesi berbayar."),
  "kursus-musik": F(true, true, true, "Pertanyaan dan materi latihan antar pertemuan; DP per sesi."),
  "personal-trainer": F(false, true, false, "Sesi dipesan per jam dengan DP; program latihan biasanya lewat chat Anda sendiri."),
  "yoga-pilates": F(false, true, false, "Kelas privat dipesan per jam dengan DP."),
  "konsultan": F(true, true, true, "Klien berkirim pertanyaan dan dokumen (tiket + berkas); DP untuk sesi berbayar."),
  "hukum-pajak": F(true, true, true, "Alur dokumen klien lewat tiket dan berkas; DP untuk konsultasi lanjutan."),
  "desainer-freelancer": F(true, false, true, "Diskusi proyek, revisi, dan file desain lewat tiket + berkas; pembayaran proyek biasanya lewat invoice sendiri."),
  "demo-produk": F(false, false, false, "Calon pelanggan cukup memilih jam demo; tanpa pembayaran, tiket, atau berkas."),
  "fotografer": F(true, true, true, "Diskusi konsep (tiket), referensi dan hasil (berkas), DP mengunci tanggal pemotretan."),
  "wedding-event": F(true, true, true, "Komunikasi panjang dengan klien, dokumen kontrak/rundown, dan DP pengunci tanggal."),
  "bengkel": F(true, false, false, "Keluhan kendaraan dicatat lewat tiket; pembayaran di bengkel."),
  "cuci-detailing": F(false, true, false, "Pesan slot; DP hanya untuk detailing panjang."),
  "sewa-lapangan": F(false, true, false, "Booking per jam dengan DP agar slot tidak kosong; tanpa tiket atau berkas."),
  "rental-mobil": F(false, true, false, "Pelanggan memilih mobil dan tanggal lalu membayar DP (persen dari total) langsung ke Anda, sehingga unit terkunci dan tidak ada pesanan iseng. Janji temu per jam dan tiket tidak diperlukan.", true),
  "rental-motor": F(false, true, false, "Pelanggan memilih motor dan tanggal lalu membayar DP agar unit terkunci; pelunasan dan jaminan diselesaikan saat serah-terima.", true),
  "sewa-kamera": F(false, true, false, "Katalog perlengkapan dengan tanggal sewa; DP mengunci barang untuk tanggal yang dipilih.", true),
  "sewa-alat-pesta": F(true, true, false, "DP mengunci alat untuk tanggal acara; pelanggan sering bertanya detail pemasangan sehingga tiket dinyalakan.", true),
  "sewa-camping": F(false, false, false, "Pesan alat berdasarkan tanggal; serah-terima langsung di tempat.", true),
  "sewa-sepeda": F(false, false, false, "Pesan unit berdasarkan tanggal; bayar dan serah-terima di tempat.", true),
  "kosong": F(true, true, true, "Semua fitur menyala; matikan yang tidak Anda perlukan."),
};

/** Jenis yang lazim dipakai perorangan; nilainya contoh nama yang cocok untuk kolom nama. */
const PERSONAL_EXAMPLES: Record<string, string> = {
  "psikolog": "Rina Wulandari, M.Psi",
  "ahli-gizi": "Dewi Pratiwi, S.Gz",
  "fisioterapi": "Budi Santoso, S.Ft",
  "les-privat": "Les Matematika Pak Andi",
  "personal-trainer": "Raka Fit Coach",
  "yoga-pilates": "Sinta Yoga Privat",
  "konsultan": "Dewi Hartono, Konsultan Bisnis",
  "hukum-pajak": "Andi Pratama, S.H.",
  "desainer-freelancer": "Nadia Desain",
  "makeup-artist": "Rias oleh Dinda",
  "fotografer": "Lensa Raka",
};

export const BUSINESS_TEMPLATES: readonly BusinessTemplate[] = RAW_TEMPLATES.map((t) => {
  const personal = t.id in PERSONAL_EXAMPLES;
  return {
    ...t,
    kind: t.kind ?? "jadwal",
    products: (t.products ?? []).map((x) => ({ ...x, dpPercent: x.dpPercent ?? 30 })),
    ...(FEATURE_PRESETS[t.id] ?? { features: DEFAULT_FEATURES, featureWhy: "" }),
    personal,
    example: PERSONAL_EXAMPLES[t.id] ?? t.example,
    nameLabel: t.id === "kosong" ? "Nama halaman jadwal" : t.kind === "sewa" ? "Nama usaha rental" : personal ? "Nama Anda atau nama praktik" : "Nama usaha atau tempat",
  };
});

export function getBusinessTemplate(id: string): BusinessTemplate {
  const t = BUSINESS_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new AppError("invalid_input", "Template tidak dikenal.");
  return t;
}

export const MAX_SETUP_SERVICES = 10;

/** Interval slot yang wajar untuk sebuah durasi (pelanggan melihat jam yang rapi). */
export function defaultStep(durationMin: number): number {
  if (!Number.isFinite(durationMin) || durationMin < 5) return 30;
  if (durationMin <= 60) return Math.max(5, Math.round(durationMin));
  return durationMin % 60 === 0 ? 60 : 30;
}

export interface BusinessSetup {
  /** Jam kerja mingguan (boleh beberapa rentang per hari). */
  availability: WeeklyRule[];
  /** Layanan awal; kode link dibuat otomatis dari nama. */
  services: { title: string; durationMin: number; depositIdr?: number; locationKind: MeetingTypeInput["locationKind"]; slotStepMin?: number }[];
}

/** "Konsultasi Awal (Gratis)" → "konsultasi-awal-gratis" (2–40 karakter; sisipan angka bila kembar). */
export function slugifyTitle(title: string, taken: ReadonlySet<string> = new Set()): string {
  const base = title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/g, "") || "layanan";
  let slug = base.length >= 2 ? base : `${base}-1`;
  for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 36)}-${i}`;
  return slug;
}

/**
 * Menyiapkan halaman jadwal baru dari rancangan yang SUDAH disesuaikan pemilik (template hanyalah titik awal).
 * Memakai fungsi jadwal core sehingga semua validasi tetap berlaku; tanpa fitur pembayaran, DP dipaksa 0.
 */
export async function applyBusinessSetup(pool: pg.Pool, actor: Actor, setup: BusinessSetup, features: Features): Promise<{ meetingTypes: number }> {
  if (!Array.isArray(setup.services) || setup.services.length > MAX_SETUP_SERVICES) throw new AppError("invalid_input", `Maksimal ${MAX_SETUP_SERVICES} layanan saat membuat usaha.`);
  await setWeeklyAvailability(pool, actor, { rules: setup.availability });
  const taken = new Set<string>();
  for (const m of setup.services) {
    const slug = slugifyTitle(m.title, taken);
    taken.add(slug);
    const durationMin = Number(m.durationMin);
    await createMeetingType(pool, actor, {
      slug,
      title: m.title,
      durationMin,
      slotStepMin: m.slotStepMin ?? defaultStep(durationMin),
      locationKind: m.locationKind,
      depositIdr: features.pembayaran ? Number(m.depositIdr ?? 0) : 0,
      minNoticeMin: 120,
      maxDaysAhead: 60,
    });
  }
  return { meetingTypes: setup.services.length };
}

/** Menerapkan template apa adanya (tanpa penyesuaian). */
export async function applyBusinessTemplate(pool: pg.Pool, actor: Actor, templateId: string, features: Features = getBusinessTemplate(templateId).features): Promise<{ meetingTypes: number }> {
  const t = getBusinessTemplate(templateId);
  return applyBusinessSetup(pool, actor, { availability: t.availability, services: t.meetingTypes.map((m) => ({ title: m.title, durationMin: m.durationMin, depositIdr: m.depositIdr, locationKind: m.locationKind, slotStepMin: m.slotStepMin })) }, features);
}
