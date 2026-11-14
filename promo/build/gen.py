# Generates promo.html (run: python3 promo/build/gen.py)
def bw(src, url, w, y0, h_css, cap=None, sub=None, vpw=1280):
    s = w / vpw  # mm per css px
    html = f'<div class="bw" style="width:{w}mm"><div class="bar"><b></b><b></b><b></b><span>{url}</span></div><div class="vp" style="height:{h_css*s:.1f}mm"><img src="../screenshots/{src}.png" style="top:{-y0*s:.1f}mm"></div></div>'
    if cap: html += f'<div class="cap">{cap}' + (f'<small>{sub}</small>' if sub else '') + '</div>'
    return f'<div style="width:{w}mm">{html}</div>'

def ph(src, w, y0, h_css, cap=None, sub=None):
    inner = w - 3.2
    s = inner / 390
    html = f'<div class="ph" style="width:{w}mm"><div class="vp" style="height:{h_css*s:.1f}mm"><img src="../screenshots/{src}.png" style="top:{-y0*s:.1f}mm"></div></div>'
    if cap: html += f'<div class="cap">{cap}' + (f'<small>{sub}</small>' if sub else '') + '</div>'
    return f'<div style="width:{w}mm">{html}</div>'

def page(n, eyebrow, title, body, lead=None, foot='Data pada gambar adalah contoh fiktif.'):
    return f'''<section class="page"><div class="top"><div class="logo">jadwalin<i>.id</i></div><span>Akses awal · {n}</span></div>
<div class="eyebrow">{eyebrow}</div><h2>{title}</h2>{f'<p class="lead">{lead}</p>' if lead else ''}
{body}
<div class="foot"><span>jadwalin.id — akses awal</span><span>{foot}</span></div></section>'''

def ul(items, cls=''):
    return f'<ul class="ck {cls}">' + ''.join(f'<li>{i}</li>' for i in items) + '</ul>'

CSS = open('style.css').read()
P = []

# 1 SAMPUL
P.append(f'''<section class="page cover"><div class="in">
<div style="display:flex;justify-content:space-between;align-items:center"><div class="logo">jadwalin<i>.id</i></div><span class="badge">Akses awal · beta tertutup</span></div>
<h1>Jadwal, tiket, DP, dan sewa — dalam satu link untuk klien Anda.</h1>
<p class="lead" style="color:#dbe7ff;font-size:12.2pt;max-width:150mm">Super app penjadwalan untuk bisnis jasa dan rental di Indonesia. Klien memesan tanpa akun, DP dibayar langsung ke Anda lalu Anda verifikasi, dan semua percakapan serta berkas tercatat rapi.</p>
<div style="display:flex;gap:8mm;margin-top:9mm;align-items:flex-start">
{bw('d3-detail-tiket','jadwalin.id/w/demo-pajak-rahayu/tiket/1',118,95,930)}
<div style="margin-top:12mm">{ph('m2-pilih-slot',52,230,1000)}</div></div>
<div style="margin-top:11mm"><p style="color:#bcd2ff;font-size:8.3pt;letter-spacing:1px;text-transform:uppercase;font-weight:700;margin-bottom:2mm">Psikolog · coach · konsultan · tutor · MUA · fotografer · rental kamera &amp; kendaraan</p>
<div class="cmp"><div><b>Sebelum</b>Jadwal lewat chat bolak-balik, bukti transfer tercecer di WhatsApp, sewa ganda.</div><div><b>Dengan jadwalin.id</b>Klien pilih tanggal sendiri, DP terverifikasi, tiket &amp; pesanan otomatis.</div></div></div>
<p style="position:absolute;left:16mm;right:16mm;bottom:10mm;font-size:7.8pt;color:#bcd2ff">Tangkapan layar adalah aplikasi yang berjalan, memakai data contoh (nama, isi percakapan, dan nomor rekening fiktif).</p>
</div></section>''')

# 2 PEMESANAN PUBLIK
P.append(page(2, 'Pemesanan publik', 'Klien memesan jadwal sendiri, tanpa akun.',
 f'''<div class="row3" style="margin-top:6mm">{ph('m1-halaman-publik',56,0,960,'Etalase layanan','Link milik Anda')}{ph('m2-pilih-slot',56,215,960,'Kalender &amp; slot kosong','Pilih tanggal, lalu jam')}{ph('m3-kelola-booking',56,0,960,'Kelola lewat tautan email','Ubah jadwal / batalkan')}</div>
<div class="grid2" style="margin-top:7mm">{ul(['Slot yang sudah dipesan <b>langsung hilang</b> dari pilihan orang lain; anti-bentrok dijaga di database.','Beberapa host dengan <b>slot gabungan</b> kalender.','Ubah jadwal atau batalkan lewat <b>tautan email</b>, tanpa login.','Layanan bisa <b>gratis atau ber-DP</b> (lihat halaman berikutnya).'])}{ul(['Email <b>konfirmasi</b> plus pengingat <b>24 jam</b> dan <b>1 jam</b> sebelum jadwal.','Perlindungan bot <b>Cloudflare Turnstile</b>, honeypot, dan pembatas laju.','Persetujuan privasi dicatat pada setiap pemesanan.','Zona waktu <b>WIB / WITA / WIT</b>.'])}</div>
<p class="lead" style="margin-top:4mm">Bagikan <b style="color:var(--ink)">jadwalin.id/nama-anda</b> di bio Instagram, WhatsApp, atau kartu nama.</p>''',
 foot='Alamat pada gambar ilustratif; layanan belum diluncurkan publik. Data contoh.'))

# 3 DP MANUAL
P.append(page(3, 'DP &amp; pembayaran manual', 'DP dibayar langsung ke Anda, Anda yang verifikasi.',
 f'''<div style="display:grid;grid-template-columns:1fr 1fr;gap:8mm;margin-top:5mm;align-items:start">
<div style="display:flex;gap:4mm">{ph('m4-bayar',46,0,1030,'Pelanggan bayar &amp; unggah bukti')}{ph('m5-bukti-terkirim',46,0,640,'Bukti diterima','Slot tetap ditahan')}</div>
<div>{bw('d7-pembayaran','jadwalin.id/w/…/pembayaran',88,95,1420,'Antrean verifikasi untuk staf','Lihat bukti, konfirmasi lunas atau tolak')}</div></div>
<div class="grid3" style="margin-top:6mm"><div class="card"><div class="stepn">1</div><h3>Atur metode bayar</h3><p>Rekening bank, QRIS, e-wallet, atau lainnya — Anda yang menentukan.</p></div><div class="card"><div class="stepn">2</div><h3>Isi DP di layanan</h3><p>Tentukan nominal DP per layanan (atau persen DP per produk sewa).</p></div><div class="card"><div class="stepn">3</div><h3>Verifikasi bukti</h3><p>Pelanggan unggah bukti, Anda cek lalu <b>konfirmasi lunas</b> atau tolak dengan alasan.</p></div></div>
<div class="card soft" style="margin-top:5mm"><b>jadwalin.id tidak memproses uang.</b> Uang berpindah langsung dari pelanggan ke rekening Anda; tidak ada fee transaksi dan tidak ada gateway. Slot ditahan selama jendela bayar dan dilepas otomatis bila tidak dibayar. Keaslian bukti transfer tetap Anda cek sendiri pada mutasi rekening.</div>''',
 foot='Nomor rekening, nama, dan bukti transfer pada gambar adalah contoh fiktif.'))

# 4 TIKET & PORTAL
P.append(page(4, 'Tiket &amp; portal klien', 'Setiap booking jadi tiket; klien punya portalnya sendiri.',
 f'''<div class="grid2" style="margin-top:5mm;align-items:start">{bw('d3-detail-tiket','jadwalin.id/w/…/tiket/1',85,95,1780,'Sisi penyedia','Percakapan, catatan internal (kuning), lampiran, meeting')}{bw('d6-tiket-klien','jadwalin.id/jadwal-saya/…/tiket/1',85,95,1780,'Sisi klien: “Jadwal saya”','Tanpa catatan internal')}</div>
<div class="grid2" style="margin-top:6mm">{ul(['<b>Booking otomatis jadi tiket</b> untuk penyedia jasa.','Penugasan ke anggota tim, status &amp; prioritas.','Komentar publik <b>dan catatan internal</b> (tak terlihat klien).','Lampiran dengan catatan konteks; meeting terjadwal dari tiket.','Riwayat perubahan lengkap dan email notifikasi.'])}{ul(['Klien melihat tiket, <b>membalas</b>, melampirkan berkas, melihat jadwal meeting, dan menutup tiket.','Tamu yang kemudian mendaftar dengan email sama (terverifikasi) otomatis melihat tiketnya.','Tim tampil sebagai nama usaha; nama staf tidak dibuka ke klien.'])}</div>
<h3 style="margin-top:5mm;font-size:12pt">Alur klien: pesan → tiket → meeting → pengingat</h3>
<div class="grid4" style="margin-top:2mm"><div class="step"><div class="n">1</div><div><b>Pesan</b><p>Pilih slot tanpa akun.</p></div></div><div class="step"><div class="n">2</div><div><b>Tiket</b><p>Otomatis untuk tim Anda.</p></div></div><div class="step"><div class="n">3</div><div><b>Meeting</b><p>Berkas &amp; tautan meeting.</p></div></div><div class="step"><div class="n">4</div><div><b>Pengingat</b><p>Email 24 jam &amp; 1 jam.</p></div></div></div>'''))

# 5 SEWA
P.append(page(5, 'Sewa barang · baru', 'Rental kamera, mobil, atau alat pesta: katalog + tanggal sewa.',
 f'''<div class="row3" style="margin-top:5mm">{ph('r1-katalog-sewa',44,0,780,'Katalog sewa')}{ph('r2-produk-sewa',44,0,780,'Pilih tanggal sewa')}{ph('r3-status-sewa',44,0,780,'Status pesanan &amp; DP')}</div>
<div class="grid2" style="margin-top:7mm;align-items:start">{bw('r5-pesanan-sewa','jadwalin.id/w/…/sewa',85,95,660,'Pesanan sewa','Konfirmasi, barang diambil, barang kembali')}{bw('r4-produk-staf','jadwalin.id/w/…/produk',85,95,660,'Produk sewa','Harga/hari, unit, DP, jaminan, foto')}</div>
<div class="grid2" style="margin-top:5mm">{ul(['Katalog produk dengan foto, harga per hari, jumlah unit.','Pelanggan memilih <b>rentang tanggal</b>; sistem <b>mencegah unit yang sama tersewa ganda</b>.','DP dalam persen dari total, uang jaminan dicatat.'])}{ul(['Pesanan ber-DP memakai alur bukti &amp; verifikasi yang sama.','Penyedia menandai <b>barang diambil</b> dan <b>barang kembali</b>.','Unit ditahan 3 jam; dilepas otomatis bila DP tak dibayar.'])}</div>
<p class="note">Sisa pembayaran dan uang jaminan diselesaikan langsung antara pemilik dan penyewa. Foto produk pada gambar adalah ilustrasi; nama merek hanyalah contoh. Belum ada pesanan manual/walk-in maupun kalender unit.</p>''',
 foot='Data pada gambar adalah contoh fiktif.'))

# 6 JADWAL, TEMPLATE, TIM
P.append(page(6, 'Pengaturan usaha', 'Siap pakai dalam hitungan menit: pilih bidang, atur jam, undang tim.',
 f'''<div class="grid2" style="margin-top:5mm;align-items:start">{bw('d8-template','jadwalin.id/dashboard/bisnis-baru',85,480,880,'30+ template bidang usaha','Layanan, jam, atau produk awal sudah terisi')}{bw('d4-jadwal','jadwalin.id/w/…/jadwal',85,100,880,'Jam kerja mingguan','Libur &amp; pengecualian tanggal, pratinjau slot')}</div>
<div class="grid2" style="margin-top:6mm;align-items:start">{bw('d4-jadwal','jadwalin.id/w/…/jadwal',85,1000,820,'Layanan &amp; host','Durasi, harga/DP, link booking, siapa yang melayani')}{bw('d1-ringkasan','jadwalin.id/w/…',85,110,820,'Ringkasan &amp; tim','Bukti menunggu, tiket aktif, anggota')}</div>
<div class="grid2" style="margin-top:5mm">{ul(['Jam rutin mingguan, libur/jam tambahan per tanggal.','Durasi, jeda (buffer), pemberitahuan minimum, rentang hari.','Zona WIB, WITA, atau WIT; <b>anti-bentrok di level database</b>.'])}{ul(['Undang anggota lewat email; peran owner / admin / staf.','Data tiap usaha <b>terisolasi di level database</b>.','Log audit kejadian penting; fitur bisa dinyalakan/dimatikan sesuai kebutuhan.'])}</div>''',
 foot='Data pada gambar adalah contoh fiktif.'))

# 7 HARGA
P.append(f'''<section class="page"><div class="top"><div class="logo">jadwalin<i>.id</i></div><span>Akses awal · 7</span></div>
<div class="eyebrow">Harga onboarding</div><h2>Mulai sendiri, atau kami siapkan untuk Anda.</h2>
<div class="grid3" style="margin-top:4mm;align-items:stretch">
<div class="tier"><div class="nm">Mandiri</div><div class="pr">Gratis</div><div class="sub">Untuk yang nyaman mengatur sendiri.</div>{ul(['Akun siap pakai','Panduan tertulis dan template','Pilih template bidang usaha, atur sendiri','Bantuan pesan untuk kendala teknis'])}</div>
<div class="tier hl"><span class="tag">Paling dipilih</span><div class="nm">Terpandu</div><div class="pr">Rp499.000 <small>sekali bayar</small></div><div class="sub">Kami yang menyiapkan, Anda tinggal pakai.</div>{ul(['Workspace &amp; profil bisnis','Hingga <b>3 layanan atau produk sewa</b>','Jam rutin &amp; libur yang Anda tentukan','Halaman link pendek <b>jadwalin.id/nama-anda</b>','Teks &amp; deskripsi halaman publik','Undangan <b>1 anggota tim</b>','Pelatihan video 45–60 menit','<b>1× revisi</b> dalam 7 hari'])}</div>
<div class="tier"><span class="tag y">USULAN</span><div class="nm">Terpandu Plus</div><div class="pr">Rp1.299.000 <small>sekali bayar</small></div><div class="sub">Untuk praktik/rental dengan tim.</div>{ul(['Semua isi Terpandu','Hingga <b>8 layanan/produk</b>, <b>5 anggota tim</b>','Beberapa host dengan slot gabungan','<b>Penyiapan pembayaran DP</b> (metode bayar &amp; DP)','Alur kerja tiket tertulis untuk tim','<b>2 sesi</b> pelatihan, <b>14 hari</b> pendampingan chat','<b>2× revisi</b> dalam 14 hari'])}</div></div>
<table style="margin-top:4mm"><tr><th style="width:24%">Syarat</th><th>Terpandu</th><th>Terpandu Plus (usulan)</th></tr>
<tr><td>Estimasi</td><td>2–3 hari kerja sejak data lengkap</td><td>4–5 hari kerja sejak data lengkap</td></tr>
<tr><td>Tidak termasuk</td><td colspan="2">Revisi di luar jatah (hanya penyesuaian pengaturan, bukan fitur baru), logo/konten, desain situs, domain kustom, biaya pihak ketiga, dan fitur yang belum tersedia.</td></tr></table>
<div class="eyebrow" style="margin-top:7mm">Rencana harga langganan</div>
<p style="margin-bottom:2mm"><b style="color:var(--ink)">Selama akses awal belum ada tagihan langganan</b>; semua fitur yang berjalan bisa dipakai. Berikut <b>rencana</b> setelah paket dibuka (belum berlaku; pengguna akses awal diberi tahu lebih dulu).</p>
<table><tr><th></th><th>Gratis</th><th>Pro</th><th>Bisnis</th></tr>
<tr><td><b>Harga bulanan</b></td><td>Rp0</td><td>Rp79.000</td><td>Rp199.000</td></tr>
<tr><td><b>Harga tahunan</b> (10× bulanan)</td><td>Rp0</td><td>Rp790.000</td><td>Rp1.990.000</td></tr>
<tr><td>Jenis layanan</td><td>3</td><td>15</td><td>50</td></tr>
<tr><td>Anggota tim</td><td>2</td><td>5</td><td>20</td></tr>
<tr><td>Berkas maks. · email/bulan</td><td>10 MB · 300</td><td>25 MB · 2.000</td><td>50 MB · 10.000</td></tr></table>
<p class="note">DP dengan bukti manual direncanakan tersedia di semua paket, tanpa fee transaksi. Batas per paket adalah usulan dan belum diterapkan di aplikasi; harga belum memperhitungkan PPN. Harga dapat berubah sebelum penagihan dibuka.</p>
<div class="foot"><span>jadwalin.id — akses awal</span><span>Harga dalam Rupiah. Syarat lengkap dikonfirmasi tertulis sebelum pengerjaan.</span></div></section>''')

# 8 KEAMANAN, ROADMAP, CTA
P.append(f'''<section class="page"><div class="top"><div class="logo">jadwalin<i>.id</i></div><span>Akses awal · 8</span></div>
<div class="eyebrow">Keamanan &amp; privasi</div><h2 style="font-size:17pt">Dibangun hati-hati sejak awal.</h2>
<div class="grid2" style="margin-top:2mm;gap:3mm"><div class="card"><h3>Data terisolasi</h3><p>Data tiap usaha dipisahkan di level database (Row-Level Security), bukan hanya di kode.</p></div><div class="card"><h3>Catatan internal tertutup</h3><p>Catatan tim dan lampiran tersembunyi tidak terlihat maupun bisa diunduh klien.</p></div><div class="card"><h3>Tautan rahasia &amp; bukti bayar</h3><p>Token disimpan sebagai hash; bukti pembayaran hanya bisa diunduh staf usaha terkait.</p></div><div class="card"><h3>Perlindungan bot, audit, cadangan</h3><p>Turnstile + pembatas laju; log audit; pencadangan harian terenkripsi dengan uji restore otomatis (dibangun, diaktifkan saat peluncuran).</p></div></div>
<p class="note" style="margin-top:2mm">Dokumen legal (syarat, privasi, refund, DPA, penggunaan wajar) sudah tersedia sebagai draf dan masih menunggu tinjauan hukum.</p>
<div class="eyebrow" style="margin-top:6mm">Peta jalan</div><h2 style="font-size:16pt">Segera hadir — belum tersedia hari ini</h2>
<p>Rencana, bukan fitur yang sudah berjalan; urutan dan waktu bisa berubah.</p>
<div class="rm" style="margin-top:2mm"><div>Pengingat WhatsApp resmi (saat ini: email)</div><div>Admin AI WhatsApp (dengan alih ke manusia)</div><div>Tagihan berulang</div><div>Kelas &amp; membership</div><div>Modul nikahan / acara</div><div>Sinkron Google Calendar</div><div>Paket berlangganan &amp; penagihan otomatis</div><div>Aplikasi seluler asli</div></div>
<div class="note" style="margin-top:3mm"><b>Jujur soal tahap kami.</b> jadwalin.id masih <b>akses awal (beta tertutup)</b>: belum dibuka untuk umum dan badan usaha belum berdiri. Kami tidak mengklaim izin/sertifikasi dan tidak menampilkan testimoni atau jumlah pelanggan.</div>
<div class="cta" style="margin-top:4mm"><div class="eyebrow" style="color:#bcd2ff">Ajakan bertindak</div><h2>Jadi pengguna akses awal.</h2><p>Tempat terbatas untuk beberapa bisnis jasa dan rental pertama. Daftar atau hubungi kami — kami bantu mulai dari onboarding.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:3mm 6mm;margin-top:4mm;font-size:10pt"><div><span class="lbl">Daftar</span><br><span class="ph-ph">[URL pendaftaran]</span></div><div><span class="lbl">WhatsApp</span><br><span class="ph-ph">[Nomor WhatsApp]</span></div><div><span class="lbl">Email</span><br><span class="ph-ph">[Email]</span></div><div><span class="lbl">Kontak</span><br><span class="ph-ph">[Nama pemilik]</span></div></div></div>
<div class="foot"><span>jadwalin.id — akses awal</span><span>Peta jalan: rencana, tanpa jaminan tanggal.</span></div></section>''')

html = f'<!doctype html><html lang="id"><head><meta charset="utf-8"><title>jadwalin.id — Akses Awal</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Outfit:wght@600;700&display=swap"><style>{CSS}</style></head><body>' + '\n'.join(P) + '</body></html>'
open('promo.html', 'w').write(html)
