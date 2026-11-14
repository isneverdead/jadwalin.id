# Riset gateway WhatsApp untuk jadwalin.id (modul wa-admin)

- Tanggal riset / akses semua sumber: **2026-11-08**
- Status dokumen: riset, BUKAN keputusan. Tidak ada kode yang diubah. Keputusan arsitektur butuh ADR (lihat bagian Rekomendasi).
- Metode: pencarian web + pembacaan halaman penyedia dan Meta. Banyak halaman penyedia adalah materi pemasaran; klaim "resmi" dari penyedia **tidak** diverifikasi ke direktori mitra Meta kecuali dinyatakan. Beberapa halaman gagal dibaca (Qontak: HTTP 403; PDF tarif Gupshup tidak terekstrak; halaman Meta tidak memuat tabel tarif Indonesia). Angka yang tidak terverifikasi ditandai **[TV]**; harga yang tidak dipublikasikan ditulis "tidak publik".

---

## 1. Ringkasan eksekutif

1. **Meta kini menagih per pesan (sejak 1 Juli 2025), bukan per percakapan.** Kategori: marketing, utility, authentication (template), service (non-template). Pesan pelanggan ke bisnis gratis. Sejak **1 Okt 2026**, menurut dokumentasi developer Meta, utility di dalam jendela layanan 24 jam kembali ditagih, dan service ditagih setelah **1.000 pesan gratis per nomor per bulan**. (Halaman pemasaran Meta versi Indonesia masih menyebut utility gratis di jendela layanan: usang; dokumen developer dijadikan acuan.)
2. **Tarif Indonesia (per pesan, di luar PPN 11%)** menurut ChatMaxima yang mengutip "kartu tarif IDR Meta" berlaku 1 Okt 2026: marketing **Rp586,33**, utility **Rp356,65**, authentication **Rp356,65**, service **Rp356,65** (setelah 1.000 gratis), authentication-international Rp1.940,13. Angka ini **tidak saya dapatkan dari sumber primer Meta** **[TV]**, tetapi konsisten dengan Zenziva (utility Rp367, marketing Rp597, kemungkinan sedikit markup) dan dengan PDF Gupshup Jan 2026 yang judulnya "IDR rates effective January 1, 2026". Wajib dicek ulang di kartu tarif Meta (CSV IDR) sebelum kontrak.
3. **Biaya terbesar bukan platform, melainkan tarif Meta yang sama untuk semua jalur resmi.** Untuk pengingat booking (utility) ≈ Rp357 per pesan. Perbedaan antar penyedia resmi hanya di biaya platform/markup: Meta direct = Rp0 platform; ChatMaxima (klaim) $19/bln tanpa markup; Twilio +$0,005 per pesan masuk maupun keluar; Zenziva tanpa biaya bulanan (klaim) tetapi tarif sedikit di atas Meta; Qiscus dan Qontak: tidak publik.
4. **Jalur tidak resmi (Fonnte Rp0–355 rb/bln, Wablas ±Rp20–139 rb/bln) sangat murah tetapi melanggar ToS WhatsApp**, tanpa SLA (Fonnte sendiri menulis "tidak akan pernah bisa memberikan SLA yang fixed" dan "tidak bertanggung jawab terkait banned"), dan pesan pelanggan lewat pihak ketiga tanpa kontrak data resmi. Ini **bertentangan dengan aturan proyek #4** dan butuh ADR + penerimaan risiko pemilik.
5. **Murah dan aman tidak harus tidak resmi.** Untuk 300–2.000 pesan/bulan, biaya WhatsApp resmi hanya sekitar **Rp86 rb–Rp571 rb/bln** (Meta saja, ex-PPN), dan email (gratis/hampir gratis) sudah bisa menjadi kanal utama; WhatsApp bisa diaktifkan sebagai add-on berbayar per paket/penyedia jasa.

**Rekomendasi singkat:** Tahap 0 = email (+ halaman klien) sebagai kanal default; Tahap 1 = WhatsApp **resmi** lewat penyedia dengan biaya platform terendah/terprediksi (kandidat: Meta Cloud API via BSP/Tech Provider murah seperti ChatMaxima atau Zenziva, atau Twilio bila butuh SDK matang), pesan utility berbasis template dengan opt-in, biaya diteruskan ke penyedia jasa; Tahap 2 = Admin AI dua arah + alih ke manusia pada platform inbox resmi. **Jangan** memakai Fonnte/Wablas/Baileys untuk data pelanggan produksi tanpa ADR.

---

## 2. Tabel perbandingan

| Penyedia | Status | Biaya platform | Biaya pesan (ID) | Free tier | Integrasi (Node) | Risiko blokir nomor | Cocok untuk jadwalin |
|---|---|---|---|---|---|---|---|
| Meta Cloud API langsung | Resmi (Meta) | Rp0 (hosting: tidak dinyatakan di halaman yang dibaca [TV]) | Tarif Meta (di atas) | 1.000 service/bln/nomor; test number | REST + webhook; 80 pesan/dtk | Rendah (selama patuh kebijakan) | Ya, tapi onboarding/verifikasi bisnis dan UI inbox harus dibangun sendiri |
| ChatMaxima | Mengaku BSP/penyedia resmi [TV] | "$19/bln flat, tanpa markup" (klaim halaman) | Tarif Meta (klaim) | tidak diketahui | tidak diverifikasi | Rendah | Kandidat murah; verifikasi status & SLA dulu |
| Zenziva | Mengaku "Partner resmi Meta BSP" [TV] | Tanpa biaya bulanan (klaim) | Util/Auth/Service Rp367, Marketing Rp597 (ex-PPN) | tidak diketahui | webhook/dokumen tidak diverifikasi | Rendah | Kandidat lokal; sekaligus SMS |
| Twilio | Resmi (BSP global) | Tidak ada bulanan | Meta + **$0,005/pesan** masuk & keluar; +$0,001 pesan gagal | Trial tanpa kartu | SDK Node matang, webhook | Rendah | Terbaik dokumentasi/keandalan, termahal untuk volume kecil-menengah |
| Qiscus | Mengaku BSP dengan akses langsung Cloud API [TV]; lencana "meta certified" | **Tidak publik** (minta penawaran) | Tarif Meta; markup tidak publik | tidak publik | API ada, detail tidak dibaca | Rendah | Bagus untuk inbox + handover; harga tidak publik, kemungkinan di atas anggaran |
| Mekari Qontak | Mengaku BSP | Tidak diverifikasi (halaman 403) | tidak diverifikasi | tidak diverifikasi | tidak diverifikasi | Rendah | Tidak dinilai |
| Gupshup, Infobip, Vonage, 360dialog, Bird, Sleekflow, Respond.io, Kata.ai, Woowa | Umumnya BSP/Tech Provider [TV] | Hanya klaim blog vendor (mis. Respond.io Starter $79/bln, SleekFlow $15/nomor/bln, Qiscus $115 di blog Chakra) | Tarif Meta ± markup | bervariasi | bervariasi | Rendah | **Tidak diverifikasi langsung di sesi ini**; lihat bagian 4.9 |
| Fonnte | **Tidak resmi** (WhatsApp Web) | Rp0–355 rb/bln | termasuk dalam paket | Gratis 1.000 pesan/bln | API + webhook sederhana | **Tinggi**, ditanggung pengguna | Teknis ya; kebijakan tidak |
| Wablas | Tidak dinyatakan; ada opsi "Cloud API resmi" [TV] | ±Rp20–139 rb/bln | termasuk dalam paket | Trial 15 hari (watermark) | HTTP API + webhook | Tinggi bila jalur Web | Seperti Fonnte |
| Baileys / whatsapp-web.js / WAHA self-host | **Tidak resmi** | Server sendiri | Rp0 | n/a | Node native | **Tinggi** | Tidak disarankan |
| Email | n/a | tidak diriset di sesi ini | n/a | sering ada | mudah | n/a | Kanal default |
| SMS Zenziva | Operator | Tanpa bulanan | Rp650–790/SMS (tergantung operator dan deposit) | tidak ada | tidak diverifikasi | n/a | Cadangan OTP/pengingat kritis |
| Telegram Bot | Resmi (API bot) | gratis (pengetahuan umum, tidak diverifikasi sesi ini) | gratis | ya | mudah | rendah | Tidak lazim di pelanggan UMKM Indonesia |

---

## 3. Fakta kebijakan WhatsApp/Meta yang relevan

- Model tarif per pesan sejak 1 Juli 2025; hanya pesan **terkirim (delivered)** yang ditagih. Pembatasan template: pesan di luar jendela layanan 24 jam hanya bisa berupa template yang disetujui. **Opt-in wajib** dan harus menyebut nama bisnis serta tujuan. Sumber: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing , https://developers.facebook.com/docs/whatsapp/cloud-api/overview (akses 2026-11-08).
- Batas laju Cloud API: default 80 pesan/detik per nomor; sekitar 1 pesan per 6 detik ke pengguna yang sama (error 131056); batas "messaging tier" ditetapkan di level portofolio (angka tier tidak dibaca di sesi ini).
- Perubahan tarif hanya pada tanggal 1 Jan/Apr/Jul/Okt dengan pemberitahuan sebulan. Per 1 Okt 2026 ada 40 perubahan tarif; ringkasan model atas halaman Meta tidak menyebut Indonesia **[TV]**. Batas waktu menambahkan metode pembayaran 30 Sep 2026; tanpa itu service tidak terkirim lewat batas gratis.
- Pesan Click-to-WhatsApp (free entry point): gratis 72 jam menurut halaman Indonesia, hingga 7 hari menurut dokumen developer; konflik tidak terselesaikan.
- Meta menyatakan "Using unauthorized third-party tools is prohibited" (Cloud API overview).
- Syarat Platform Bisnis WhatsApp (efektif 23 Sep 2026) memberi Meta hak menangguhkan akses "kapan saja dan untuk alasan apa pun", termasuk karena umpan balik negatif berlebihan atau blokir pengguna: https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform
- FAQ "Unauthorized Automated or Bulk Messaging": WhatsApp menyatakan aplikasi pribadi dan Business App tidak dimaksudkan untuk pesan massal/otomatis, memakai machine learning untuk memblokir akun, dan **dapat menempuh jalur hukum** terhadap pelaku, termasuk atas bukti dari luar platform: https://faq.whatsapp.com/5957850900902049
- ToS konsumen melarang "bulk messaging, auto-messaging, auto-dialing", pembuatan akun otomatis, dan API tak resmi yang berfungsi serupa layanan WhatsApp: https://www.whatsapp.com/legal/terms-of-service

---

## 4. Per penyedia

### 4.1 Meta WhatsApp Cloud API langsung (tanpa BSP)
- **Status:** resmi, sumber primer Meta. Halaman yang dibaca tidak menyatakan wajib atau tidaknya BSP; ada jalur Tech Provider/BSP dan Credit Line API untuk penyedia. Verifikasi bisnis tidak diwajibkan oleh halaman itu tetapi memengaruhi throughput dan status akun resmi. Kebutuhan: portofolio bisnis, nomor khusus (tidak sedang dipakai di aplikasi WhatsApp biasa [umum, TV]), metode pembayaran, template disetujui.
- **Harga:** tarif Meta (bagian 5). Biaya hosting: tidak dinyatakan di halaman yang dibaca **[TV]**. Biaya platform: Rp0.
- **Integrasi:** REST + webhook, cocok TypeScript. Perlu membangun sendiri: inbox, handover, penyimpanan opt-in, penanganan status webhook (`regular` vs `free_customer_service` berubah mulai 1 Okt 2026).
- **Risiko:** akun ditangguhkan jika kualitas buruk; tidak ada layanan pelanggan bila bermasalah (eskalasi lebih sulit tanpa BSP).
- **Kecocokan:** sangat cocok dengan aturan arsitektur (#2 satu kanal notifikasi di core, #11 outbox). Pilihan paling murah dan resmi bagi solo dev yang mau membangun sendiri. Catatan: jika jadwalin ingin menjadi "Tech Provider" yang melayani nomor WA milik penyedia jasa (multi-tenant), itu proses onboarding Meta terpisah (embedded signup); tidak diriset mendalam di sini.

### 4.2 ChatMaxima
- Halaman Indonesia: tarif IDR "kartu tarif resmi Meta" berlaku 1 Okt 2026; klaim **$19/bln flat tanpa markup per pesan**. Sumber: https://chatmaxima.com/whatsapp-api-pricing/indonesia/ (akses 2026-11-08).
- Tidak diverifikasi: status BSP/Tech Provider, SLA, lokasi data, kualitas API/webhook. Sumber adalah pemasaran vendor; perlakukan sebagai kandidat yang perlu uji.

### 4.3 Zenziva
- Mengaku "Partner resmi Meta BSP" **[TV]**; WABA: utility/authentication/service Rp367, marketing Rp597 per pesan, belum termasuk PPN 11%; "tanpa biaya bulanan atau tersembunyi". Notes: service ditagih mulai 1 Okt 2026. Tidak jelas apakah angka mencakup tarif Meta (kemungkinan ya, sedikit di atas Rp356,65 → markup sekitar 3%) **[TV]**; biaya setup/registrasi nomor tidak dinyatakan. Juga menjual SMS. Sumber: https://zenziva.id/pricing (akses 2026-11-08).
- Tidak dibaca: dokumentasi API/webhook, SLA, lokasi data.

### 4.4 Twilio
- Resmi (BSP global). Tarif: **$0,005 per pesan masuk atau keluar** + tarif Meta diteruskan; $0,001 untuk pesan gagal; tanpa biaya bulanan atau minimum yang ditemukan; trial tanpa kartu. Kartu tarif CSV Twilio untuk Indonesia: marketing $0,0411, utility $0,025, authentication $0,025, authentication-international $0,136, service $0,025 (per pesan; tidak jelas apakah Meta saja atau total). Angka utility USD 0,025 (≈Rp400+ pada kurs ±16.000–16.500 **[kurs asumsi]**) agak di atas Rp356,65: selisih mungkin karena tanggal/kurs. Sumber: https://www.twilio.com/en-us/whatsapp/pricing , https://www.twilio.com/content/dam/twilio-com/pricing-data/en/WhatsAppPricing-pricing-details.csv (akses 2026-11-08).
- Kelebihan: SDK Node, dokumentasi, keandalan. Kekurangan: biaya per pesan masuk memakan percakapan dua arah; data diproses di luar Indonesia (lokasi tidak diperiksa di sesi ini).

### 4.5 Qiscus
- Menyatakan diri BSP dengan akses langsung ke Cloud API Meta, lencana "meta certified" di footer, badge PSE Komdigi (lencana pendaftaran, bukan bukti lokasi data), kantor Jakarta/Yogyakarta/Singapura. Harga **tidak publik** (formulir "Minta Penawaran", bergantung produk, jumlah agen, pelanggan aktif/bulan, channel). Markup di atas Meta: tidak publik. Sumber: https://www.qiscus.com/id/pricing/ , https://www.qiscus.com/id/blog/whatsapp-partner-indonesia/ (akses 2026-11-08).
- Blog pihak ketiga menyebut Startup $115/bln dan Grow $270/bln (sumber: Chakra, https://chakrahq.com/article/solusi-whatsapp-api-terbaik-indonesia-2026/ ) **[TV]**, jangan dipakai sebagai harga.
- Kecocokan: kuat untuk inbox/alih ke manusia, tetapi berpotensi di luar anggaran tahap awal.

### 4.6 Mekari Qontak
- Qontak mengklaim BSP resmi (https://qontak.com/en/features/whatsapp-bsp/, hanya terlihat di hasil pencarian). Halaman bantuan harga Oktober 2026 menolak diakses (HTTP 403) sehingga **tarif dan markup tidak diverifikasi**.

### 4.7 Fonnte (tidak resmi)
- Menyatakan sendiri di halamannya: "Layanan fonnte merupakan layanan unofficial", tidak berjalan di atas API resmi WhatsApp, memakai WhatsApp Web, tidak ada SLA tetap, "tidak bertanggung jawab terkait banned", "resiko banned tetap ada", "peluang terkena banned sama baik gratis maupun berbayar". Sumber: https://fonnte.com/ (akses 2026-11-08; sebagian isi halaman diterima dalam bentuk ringkasan otomatis, **verifikasi di halaman langsung**).
- Paket bulanan: Free Rp0 (1.000 pesan), Lite Rp25.000 (1.000), Regular Rp66.000 (10.000), Regular Pro Rp110.000 (25.000), Super Rp165.000 (10.000), Master Rp175.000 (tak terbatas), Advanced Rp255.000 (25.000), Ultra Rp355.000 (tak terbatas). Paket text-only tanpa lampiran. Kecepatan hingga sekitar 10 pesan/detik. API + webhook sederhana tersedia.
- Tidak dibaca: Syarat & Ketentuan, Disclaimer, lokasi data.

### 4.8 Wablas
- Halaman tidak menyatakan jelas jalur sambungan. Fitur "Support WhatsApp API Cloud" menyiratkan ada opsi resmi, tetapi paket standar kemungkinan berbasis WhatsApp Web; fitur "delay time … untuk menghindari banned" dan filter "bad words" mengindikasikan risiko blokir dikelola sendiri **[TV, penafsiran]**. Sumber: https://wablas.com/ , https://wablas.com/pricing (akses 2026-11-08).
- Harga (per bulan, Rp; harga efektif 12 bulan / standar): Nano 22 rb (1.000 pesan), Lite 20 rb/36 rb (5.000), Small 38 rb/69 rb (10.000), Medium 47 rb/86 rb (tak terbatas), Large 65 rb/119 rb, Enterprise 76 rb/139 rb. Trial 15 hari dengan watermark. Webhook teks/media/status tersedia.

### 4.9 Penyedia lain yang disebut tugas
Gupshup, Infobip, Vonage, 360dialog, MessageBird/Bird, SleekFlow, Respond.io, Kata.ai, Woowa, Wati dan lainnya: **tidak diriset langsung** di sesi ini (waktu/sumber terbatas). Dari hasil pencarian: banyak yang BSP/Tech Provider resmi, tetapi harga berupa klaim blog pesaing (mis. Respond.io Starter $79/bln + biaya Meta, SleekFlow $15 per nomor/bln). Gupshup menerbitkan kartu tarif PDF "IDR rates effective January 1, 2026", tetapi isinya tidak terekstrak. Jangan memakai angka ini tanpa verifikasi; kandidat tahap berikutnya bila perlu dibandingkan lewat penawaran tertulis.

### 4.10 Baileys / whatsapp-web.js / WAHA (self-hosted, tidak resmi)
Tidak diakses langsung; analisis berdasar ToS WhatsApp di atas: meniru klien WhatsApp (ToS melarang software/API tak resmi dan otomatisasi). Biaya uang Rp0 tetapi risiko blokir, pemeliharaan bila protokol berubah, dan beban keamanan sesi (kredensial sesi = akses penuh ke akun WhatsApp) ada pada kita.

### 4.11 Pembanding non-WhatsApp
- **Email:** biaya per email tidak diriset di sesi ini; jadwalin sudah memakai outbox email (`enqueueEmail`). Kekurangan: keterbacaan di UMKM Indonesia lebih rendah dari WA.
- **SMS (Zenziva, masking):** Rp650–790 per SMS (Telkomsel 720→650, XL 790→720, Indosat/Tri 750→680, Smartfren 770→700 menurut tingkat deposit Rp500 rb–Rp100 jt; ex-PPN). Sumber: https://zenziva.id/pricing . **Lebih mahal dari WA utility (±Rp357)**, jadi hanya cadangan.
- **Telegram Bot / web push:** gratis secara teknis (pengetahuan umum, tidak diverifikasi di sesi ini), tetapi adopsi pelanggan klinik/salon Indonesia rendah; tidak cocok sebagai kanal utama.

---

## 5. Simulasi biaya

Asumsi (milik saya, bukan fakta penyedia):
- Tarif Meta (ex-PPN 11%): utility Rp356,65; service Rp356,65 setelah 1.000 gratis/bln; diskon volume utility mulai kecil dan diabaikan.
- Campuran: **80% pesan keluar = utility** (konfirmasi/pengingat; mulai 1 Okt 2026 ditagih juga dalam jendela layanan), **20% = service** (balasan dalam 24 jam). Pesan masuk pelanggan gratis di Meta tetapi dihitung di Twilio: asumsi 20% dari jumlah pesan keluar.
- Kurs asumsi **Rp16.500/USD** [TV, hanya untuk konversi biaya USD].
- Semua angka **belum PPN 11%**, pembulatan ke Rp.

| Skenario | Meta saja (dasar semua jalur resmi) | + Meta Cloud direct | + ChatMaxima ($19 ≈ Rp313.500) | + Twilio ($0,005 × pesan keluar+masuk) | Zenziva (Rp367 semua pesan; tanpa gratis 1.000 [TV]) |
|---|---|---|---|---|---|
| 300 pesan/bln (240 util, 60 svc) | 85.596 | **85.596** | ≈399.100 | 85.596 + 29.700 = **115.296** | **110.100** |
| 2.000 pesan/bln (1.600 util, 400 svc) | 570.640 | **570.640** | ≈884.100 | 570.640 + 198.000 = **768.640** | **734.000** |
| 10.000 pesan/bln (8.000 util, 2.000 svc) | 3.209.850 | **3.209.850** | ≈3.523.350 | 3.209.850 + 990.000 = **4.199.850** | **3.670.000** |

Perbandingan jalur tidak resmi (hanya untuk informasi, per paket bulanan): 300 pesan → Fonnte Free/Lite Rp0–25 rb, Wablas Nano/Lite Rp20–36 rb; 2.000 pesan → Fonnte Regular Rp66 rb, Wablas Lite/Small Rp36–69 rb; 10.000 pesan → Fonnte Regular Pro Rp110 rb (aman bila pesan masuk dihitung), Wablas Small/Medium Rp69–86 rb. Mereka **10–40× lebih murah di skala menengah**, dan itulah daya tariknya; harga yang sebenarnya dibayar adalah risiko di bagian 6.

Perbandingan SMS (Zenziva, ±Rp720 rata-rata, 80% utility-equivalent semua dikirim SMS): 300 → ±Rp216 rb; 2.000 → ±Rp1,44 jt; 10.000 → ±Rp7,2 jt.

Catatan: (1) angka Zenziva tidak dapat dipecah; (2) ChatMaxima/Qiscus/Qontak fee bulanan pada skenario kecil **mendominasi** biaya, jadi pada 300 pesan/bln Meta direct atau Zenziva/Twilio jauh lebih murah; (3) di 10.000 pesan/bln, Twilio paling mahal karena $0,005 per pesan; (4) ongkos email atau penagihan ke penyedia jasa (pass-through per pesan) belum dimodelkan.

---

## 6. Matriks risiko

Skala: Rendah / Sedang / Tinggi.

| Opsi | Keamanan | Hukum/ToS | Privasi (UU PDP) | Keandalan |
|---|---|---|---|---|
| Meta Cloud API langsung | Rendah (token Meta disimpan di secret/env, validasi tanda tangan webhook) | Rendah | Sedang: data lewat Meta; butuh DPA, persetujuan, transfer lintas negara | Sedang-baik; dukungan terbatas tanpa BSP |
| BSP resmi (Twilio/Zenziva/Qiscus/ChatMaxima) | Rendah-sedang (tambah satu pihak penyimpan pesan) | Rendah | Sedang: pemroses data tambahan; perlu perjanjian pemrosesan data, cek lokasi data (tidak diverifikasi) | Baik; SLA hanya bila tertulis |
| Fonnte/Wablas (WA Web) | **Tinggi**: sesi WhatsApp penyedia jasa disimpan pihak ketiga; kebocoran = akses ke seluruh chat | **Tinggi**: melanggar ToS WhatsApp (bulk/auto-messaging, API tak resmi); WhatsApp menyatakan bisa menempuh jalur hukum | **Tinggi**: isi pesan pelanggan (bisa data kesehatan di klinik) melewati pihak tanpa perjanjian pemrosesan data jelas; sulit memenuhi DPIA | **Tinggi**: tanpa SLA; nomor dapat diblokir sewaktu-waktu, jadwal pasien tidak terkirim |
| Baileys/whatsapp-web.js self-host | Sedang-tinggi (kita memegang kredensial sesi sendiri) | **Tinggi** (sama) | Sedang (data tetap di kita, tapi tetap lewat klien tak resmi) | **Tinggi** (protokol bisa berubah, nomor diblokir) |
| Email | Rendah | Rendah | Rendah-sedang | Sedang (spam folder) |
| SMS | Rendah | Rendah | Sedang | Baik tetapi mahal |
| Telegram | Rendah | Rendah | Sedang | Baik, adopsi rendah |

Catatan keandalan Meta: akun/ nomor bisa ditangguhkan bila kualitas turun; ini juga risiko jalur resmi, tetapi ada mekanisme banding dan batas tier yang transparan.

---

## 7. Rekomendasi bertahap

**Tahap 0 (sekarang, Rp0 tambahan): email sebagai kanal default.** Infrastruktur outbox sudah ada. Tawarkan WhatsApp sebagai fitur berbayar belakangan; ini juga menekan risiko DPIA awal.

**Tahap 1 (WhatsApp resmi, biaya rendah, pengingat satu arah):**
1. Prioritas: **Meta Cloud API langsung** (platform Rp0) bila waktu development tersedia; pilih BSP bila ingin pendamping onboarding. Untuk volume kecil (≤2.000 pesan/bln), **Zenziva** (lokal, tanpa bulanan, tarif sedikit di atas Meta) dan **Twilio** (dokumentasi/SDK terbaik) adalah kandidat berbiaya rendah dengan risiko rendah; **ChatMaxima** menarik hanya bila $19/bln terverifikasi dan skala >3.000 pesan.
2. Hanya template **utility** (konfirmasi/pengingat/perubahan jadwal), dengan opt-in tercatat saat booking (`privacyAck` + centang WA), dan nomor pengirim milik penyedia jasa/jadwalin. Biaya per pesan diteruskan atau dikuota per paket (entitlements, aturan #12; kuota dikurangi dalam transaksi outbox, aturan #11).
3. Satu adapter kanal di `core` (aturan #2), webhook diproses idempoten (pola `webhook_inbox`), verifikasi tanda tangan webhook.
4. Sebelum kontrak: ambil kartu tarif IDR resmi dari Meta, minta DPA dan lokasi data tertulis, cek status mitra di direktori Meta.

**Tahap 2 (jalur resmi penuh, dua arah, Admin AI):** saat ada balasan dua arah volume signifikan, pindah ke BSP dengan inbox/handover (kandidat: Qiscus, Qontak, Respond.io/SleekFlow; minta penawaran tertulis) atau bangun inbox sendiri di atas Cloud API. Admin AI wajib alih ke manusia dan menyatakan balasan otomatis (aturan #4); DPIA khusus untuk Admin AI dan data kesehatan.

**Titik pindah dari tahap 1 ke 2:** (a) ≥ sekitar 3.000 pesan/bln atau ≥ 3 penyedia jasa aktif memakai WA, (b) ada permintaan balasan dua arah, (c) satu insiden kualitas/penangguhan.

**Tidak disarankan:**
- **Fonnte/Wablas/WAHA/Baileys/whatsapp-web.js untuk produksi.** Alasan: melanggar ToS WhatsApp; nomor penyedia jasa (aset bisnis mereka) bisa diblokir dan jadwal pasien gagal terkirim; Fonnte sendiri menolak SLA dan tanggung jawab; pesan memuat data pribadi (potensi kesehatan) lewat pihak tanpa perjanjian pemrosesan data memadai, sulit memenuhi UU PDP; jadwalin sebagai platform akan ikut bertanggung jawab ke penyedia jasa. Jangan menjual ini ke klien sebagai "WhatsApp resmi".
- Mengakali deteksi atau pembatasan WhatsApp (rotasi nomor, penundaan acak, dsb.). Tidak dibahas dan tidak direkomendasikan.
- Memilih penyedia berdasarkan harga blog pesaing tanpa penawaran tertulis; memakai SMS sebagai kanal massal (lebih mahal dari WA).

**Jika pemilik tetap ingin jalur tidak resmi** (misalnya untuk uji internal atau notifikasi ke nomor milik sendiri), itu **bertentangan dengan aturan proyek #4** ("hanya WhatsApp Business API resmi lewat BSP") dan **wajib** didahului **ADR di `docs/adr/`** yang mencatat: ruang lingkup terbatas (bukan data klien nyata), penerimaan risiko tertulis oleh pemilik, pemutusan bila diblokir, tidak ada pesan sensitif/kesehatan, informasi ke penyedia jasa soal risiko, dan rencana migrasi ke jalur resmi. Perubahan ini bukan keputusan teknis semata.

---

## 8. Hal yang tidak terverifikasi / tindak lanjut

- Kartu tarif IDR resmi Meta (sumber primer) tidak berhasil diambil; angka Indonesia berasal dari ChatMaxima/Zenziva/Twilio CSV, yang saling berbeda tipis (Rp356,65 vs Rp367; USD 0,025 vs IDR).
- Qontak (403), Infobip/Vonage/360dialog/Bird/SleekFlow/Respond.io/Kata.ai/Woowa/Gupshup tidak diriset langsung; status resmi hanya klaim.
- Lokasi data, SLA, dan dokumentasi API/webhook Zenziva, Qiscus, ChatMaxima tidak dibaca.
- Biaya Cloud API hosting di Meta langsung tidak dinyatakan pada halaman yang dibaca.
- Syarat & Ketentuan Fonnte/Wablas tidak dibaca; sebagian halaman Fonnte diterima sebagai ringkasan otomatis.
- Biaya email, Telegram, push tidak diriset; sebutan itu pengetahuan umum.
- Tiga batas tier pesan Meta dan aturan jendela 24 jam rinci tidak dibaca.

## 9. Sumber (akses 2026-11-08)
- https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing
- https://developers.facebook.com/docs/whatsapp/cloud-api/overview
- https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform
- https://www.whatsapp.com/legal/terms-of-service
- https://faq.whatsapp.com/5957850900902049
- https://chatmaxima.com/whatsapp-api-pricing/indonesia/
- https://www.gupshup.ai/resources/wp-content/uploads/2025/12/IDR_Jan2026.pdf (hanya judul/tanggal)
- https://www.twilio.com/en-us/whatsapp/pricing
- https://www.twilio.com/content/dam/twilio-com/pricing-data/en/WhatsAppPricing-pricing-details.csv
- https://zenziva.id/pricing , https://www.zenziva.id/
- https://www.qiscus.com/id/pricing/ , https://www.qiscus.com/id/blog/whatsapp-partner-indonesia/
- https://fonnte.com/ , https://wablas.com/ , https://wablas.com/pricing
- https://chakrahq.com/article/solusi-whatsapp-api-terbaik-indonesia-2026/ (blog vendor, sekunder)
