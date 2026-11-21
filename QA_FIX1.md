# QA — Saring Suara Fix 1
Tanggal: 21 November 2026

## Basis
- Sumber: `saring-suara-pages.zip` dari Google Drive (65.173.796 byte).
- Model dan binari WASM dari `vendor/` tidak dimodifikasi.
- Deployment yang dituju: GitHub Pages `main/(root)`.

## Hasil tes aktual
- [PASS] ZIP sumber berhasil diekstrak, CRC valid.
- [PASS] Pemeriksaan sintaks Node 22 terhadap `app.js`, `worker.js`, `demucs-worker.js`, `separation.js`.
- [PASS] Headless Chromium: UI HTML/JS, pemilihan file, pratinjau Dialog ringan, guard HTDemucs pada user-agent iPhone.
- [PASS] Headless Chromium dengan Worker simulasi: alur audio HTDemucs `extract -> demucs -> WAV`.
- [PASS] Headless Chromium dengan Worker simulasi: alur video HTDemucs `extract -> demucs -> mux`.
- [PASS] Headless Chromium dengan Worker simulasi: alur ekspor RNNoise.
- [PASS] Headless Chromium dengan Worker simulasi: tombol Batalkan; hasil dari pekerjaan lama tidak muncul.
- [PASS] Model AI dan aset FFmpeg tetap tersedia di paket.

## Belum terverifikasi
- [NOT TESTED] Eksekusi model HTDemucs yang sebenarnya (CPU/WASM) di iPhone 13 Safari/Chrome.
- [NOT TESTED] FFmpeg WebAssembly yang sebenarnya pada perangkat pengguna.
- [NOT TESTED] Audio 1 jam, MOV/HEVC, PWA/A2HS.
- [NOT TESTED] Codec output MP4 berbagai tipe video. Kode tidak bisa menjamin dukungan semua input.

## Catatan pengujian
Karena keterbatasan lingkungan browser otomasi, tidak dilakukan uji E2E pada binari WebAssembly yang sebenarnya. Alur Worker diuji dengan Worker mock; **hasil ini tidak berarti crash iPhone sudah dipastikan hilang**. Lakukan uji perangkat setelah deploy.

## Uji iPhone yang disarankan
1. Buka GitHub Pages di Safari, pilih klip 18 detik yang sama.
2. Jalankan `Dialog ringan`; pastikan video bisa diputar, pause, dan suaranya terdengar.
3. Buka ulang; pastikan tidak ada pesan sesi terputus yang salah.
4. Jalankan `Dialog RNNoise · ekspor`, jika siap menghadapi kemungkinan refresh.
5. HTDemucs hanya untuk uji eksperimen dengan checkbox izin. Periksa status terakhir jika tab tertutup.
