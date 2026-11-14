> **TIDAK DIPAKAI (2026-11-08):** pemilik memutuskan tidak memakai payment gateway (docs/adr/0002-pembayaran-manual.md). Dokumen ini disimpan sebagai arsip; jangan dikirim.

# Checklist pengajuan aplikasi baru ke Midtrans

Daftar umum yang biasa diminta; daftar pasti harus dikonfirmasi ke Midtrans. Status per 2026-11-08.

## Dokumen dan data

| Item | Status | Catatan |
|---|---|---|
| Akun Midtrans yang sudah disetujui | Sudah ada (pemilik) | Isi Merchant ID dan nama merchant di email |
| Deskripsi bisnis/aplikasi | Sudah ada | Ada di email |
| URL situs yang bisa diakses | Belum ada | Belum ada URL produksi; Midtrans biasanya mensyaratkan situs aktif. Bisa pakai staging jika diterima |
| Halaman Syarat Layanan, Kebijakan Privasi, Kebijakan Refund | Belum ada | Sedang disiapkan di proyek, belum final |
| Informasi kontak dan identitas usaha di situs | Belum ada | Tergantung status badan usaha |
| Badan usaha (PT Perorangan), akta/SK Kemenkumham | Belum ada | Belum berdiri; perlu keputusan pemilik |
| NIB | Belum ada | Mengikuti pendirian badan usaha |
| NPWP badan/pemilik | Perlu pemilik | Pastikan atas nama siapa |
| KTP pemilik/penanggung jawab | Perlu pemilik | Sudah terdaftar di akun yang ada; konfirmasi perlu dikirim ulang atau tidak |
| Rekening bank penampung settlement | Perlu pemilik | Sesuai nama entitas; ingat prinsip jadwalin tidak menampung dana pihak ketiga |
| Perizinan terkait platform pembayaran pihak lain | Belum diketahui | Ditanyakan ke Midtrans |
| Perkiraan volume dan nilai transaksi | Perlu pemilik | Jangan mengarang angka |
| Akses sandbox / kunci uji | Belum ada | Diminta lewat email |
| Skema biaya (MDR) | Belum ada | Diminta lewat email |

## Placeholder yang masih harus diisi pemilik

- Tidak ada lagi: Merchant ID M646808953 sudah diisi.

Sudah diisi: nama lengkap, nama aplikasi lama (spendae.com), email akun, nomor telepon, pemilik akun (pribadi), URL jadwalin.id, status badan usaha (dikelola pribadi, PT Perorangan belum berdiri). Volume transaksi: ditulis "belum dapat diperkirakan".

## Hal yang dipastikan sebelum mengirim

1. Status badan usaha: sampaikan apa adanya; jangan mengaku sudah berbadan hukum, ber-NIB, atau berizin.
2. Apakah akun yang ada boleh dipakai untuk aplikasi baru dengan entitas hukum berbeda.
3. Pastikan tidak ada nama klien, angka pelanggan, atau pendapatan di email.
4. Fitur pembayaran belum dibangun: tetap tulis sebagai rencana integrasi.
