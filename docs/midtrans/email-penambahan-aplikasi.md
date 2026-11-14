> **TIDAK DIPAKAI (2026-11-08):** pemilik memutuskan tidak memakai payment gateway (docs/adr/0002-pembayaran-manual.md). Dokumen ini disimpan sebagai arsip; jangan dikirim.

# Draf email: penambahan aplikasi baru ke akun Midtrans


**Kepada:** support@midtrans.com
**Subjek:** Penambahan aplikasi baru - Jadwalin.id (Merchant ID M646808953)

---

## Versi lengkap

Yth. Tim Dukungan Midtrans,

Saya Fariz Akbar Shalahhuddin dari Fariz Akbar Shalahhuddin (perorangan), pemilik akun Midtrans Merchant ID M646808953 (email akun: farizakbarshalahhuddin@gmail.com). Melalui akun tersebut, aplikasi kami spendae.com telah terdaftar dan disetujui.

Saya ingin menambahkan **satu aplikasi baru, Jadwalin.id**, dan mohon petunjuk prosedurnya: apakah aplikasi baru dapat ditambahkan di bawah akun/merchant yang sama, atau perlu merchant/Merchant ID baru? Dokumen tambahan apa yang diperlukan?

**1. Profil aplikasi**
Jadwalin.id adalah platform penjadwalan untuk bisnis jasa di Indonesia (misalnya psikolog, coach, penata rias, fotografer, tutor, dan konsultan). Fitur utamanya: halaman pemesanan jadwal publik, sistem tiket, portal klien, dan pengingat jadwal.

Pembayaran yang kami rencanakan:
- uang muka (DP) dan pembayaran jasa dari klien kepada penyedia jasa;
- langganan paket dari penyedia jasa kepada Jadwalin.

Metode yang kami harapkan: QRIS, Virtual Account bank (BCA, Mandiri, BNI, BRI, Permata), e-wallet jika tersedia, dan kami ingin tahu apakah opsi kartu relevan dan tersedia untuk kasus ini.

**2. Model aliran dana (mohon arahan)**
Prinsip kami, Jadwalin tidak menampung dana pihak ketiga. Dana pembayaran klien semestinya diterima penyedia jasa, dan Jadwalin hanya mengambil biaya platform. Kami ingin menanyakan:
1. Apakah Midtrans mendukung model platform/marketplace seperti ini, misalnya melalui sub-merchant atau pemisahan (split) settlement ke beberapa pihak?
2. Jika ya, bagaimana proses onboarding penyedia jasa sebagai sub-merchant, bagaimana pelaporan rekonsiliasinya, dan produk apa yang digunakan (Snap, Core API, Payment Link, atau Payouts)?
3. Apa batasan, kebijakan, atau persyaratan perizinan bagi platform yang memfasilitasi pembayaran untuk pihak lain?
4. Jika model ini tidak didukung, alternatif apa yang Midtrans sarankan?

**3. Status badan usaha (mohon kebijakan)**
Secara terbuka kami sampaikan: badan usaha untuk Jadwalin.id belum berdiri (direncanakan berbentuk PT Perorangan), sedangkan akun Midtrans yang ada atas nama Fariz Akbar Shalahhuddin (pribadi). Untuk saat ini aplikasi dikelola oleh saya selaku pemilik secara pribadi.. Bagaimana Midtrans menangani aplikasi baru yang entitas hukumnya berbeda atau masih dalam proses pendirian? Apakah aplikasi dapat didaftarkan sementara di bawah akun yang ada, atau sebaiknya menunggu entitas baru?

**4. Status aplikasi**
Aplikasi masih tahap pengembangan/beta tertutup dan belum tersedia untuk publik. Fitur pembayaran belum dibangun; ini adalah rencana integrasi. Kami memerlukan akses sandbox agar dapat mengintegrasikan dan menguji. Notifikasi pembayaran (webhook) akan diverifikasi tanda tangannya dan diproses secara idempoten. URL situs: jadwalin.id.

**5. Perkiraan volume**
- Perkiraan jumlah transaksi per bulan: belum dapat kami perkirakan karena masih tahap pengembangan.
- Perkiraan nilai rata-rata transaksi: belum dapat kami perkirakan; mohon informasi apakah ada ketentuan minimum volume.

**Permintaan kami:**
1. Konfirmasi prosedur penambahan aplikasi (akun yang sama atau merchant baru).
2. Daftar dokumen dan persyaratan.
3. Akses sandbox / kunci uji untuk aplikasi baru.
4. Skema biaya (MDR) untuk model ini.
5. Perkiraan waktu proses.

Terima kasih atas bantuannya. Kami siap melengkapi informasi atau dokumen yang diperlukan.

Hormat saya,

Fariz Akbar Shalahhuddin
Fariz Akbar Shalahhuddin (perorangan)
Merchant ID: M646808953
Telepon/WhatsApp: 08567500965
Email akun Midtrans: farizakbarshalahhuddin@gmail.com

---

## Versi ringkas (±120 kata)

**Subjek:** Penambahan aplikasi baru - Jadwalin.id (Merchant ID M646808953)

Yth. Tim Midtrans, saya Fariz Akbar Shalahhuddin, pemilik akun M646808953 (aplikasi spendae.com, sudah disetujui). Saya ingin menambahkan aplikasi baru, Jadwalin.id, platform penjadwalan untuk bisnis jasa (pemesanan publik, tiket, portal klien), tahap pengembangan, situs jadwalin.id. Rencana: DP/pembayaran jasa dan langganan via QRIS, VA, e-wallet. Dana klien seharusnya ke penyedia jasa, platform hanya mengambil fee: apakah Midtrans mendukung sub-merchant/split settlement? Badan usaha belum berdiri (kini dikelola pribadi). Mohon info: prosedur (akun sama atau MID baru), dokumen, akses sandbox, MDR, estimasi waktu. Volume belum dapat diperkirakan (tahap pengembangan). Terima kasih. Fariz Akbar Shalahhuddin, 08567500965.

---

## Catatan internal (jangan disalin ke email)

- Istilah produk Midtrans yang terverifikasi di docs.midtrans.com: Snap, Core API, Payment Link, Payouts (sebelumnya Iris). Di Midtrans, Mandiri berupa "Mandiri Bill Payment".
- Dukungan sub-merchant/split settlement di Midtrans TIDAK ditemukan di dokumentasi publik; karena itu diajukan sebagai pertanyaan, bukan klaim.
