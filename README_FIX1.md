# Saring Suara — Fix 1 (21 November 2026)

Versi ini merupakan perbaikan stabilitas dari `saring-suara-pages.zip`, **bukan** implementasi final pemutar AI yang menghapus musik secara real-time.

## Perubahan

1. **FFmpeg dipisahkan dari HTDemucs.** Pemrosesan vokal berjalan dalam tiga tahap: ekstraksi audio menggunakan `worker.js`, pemisahan menggunakan `demucs-worker.js`, kemudian (jika perlu) mux video dengan `worker.js` yang baru. Worker sebelumnya dihentikan sebelum tahap berikutnya.
2. **Mode Dialog ringan tanpa FFmpeg.** Pilih `Dialog ringan · langsung diputar` untuk memutar video/audio lokal dengan Web Audio EQ dan kompresor. Tidak memuat FFmpeg atau model HTDemucs. Mode ini **bukan penghapusan musik berbasis AI**, dan tidak menyediakan ekspor.
3. **Mode RNNoise lama tetap tersedia** sebagai `Dialog RNNoise · ekspor (FFmpeg)`, tetapi berpotensi terlalu berat di iPhone. Audio hasilnya M4A, video MP4 jika codec cocok.
4. **Pengaman HTDemucs pada iPhone.** Sebelum menjalankan model sekitar 52 MiB, pengguna harus menandai persetujuan eksperimen, karena iOS dapat menutup halaman jika memori tidak cukup.
5. **Diagnostik crash.** Tahap terakhir pemrosesan dicatat melalui `sessionStorage`. Jika halaman dimuat ulang tanpa menyelesaikan tahap, pesan pemulihan muncul pada pembukaan berikutnya.
6. **Batalkan dan bersihkan sumber daya.** Worker aktif dihentikan, permintaan asinkron dibatalkan, player/source object URL lama dibersihkan, dan AudioContext pratinjau ditutup.
7. **Ekspor audio HTDemucs sebagai WAV 44,1 kHz, stereo, 16-bit**, agar tidak perlu memuat FFmpeg kedua kali saat hanya membutuhkan audio. Ekspor HTDemucs dengan video masih membutuhkan tahap mux MP4.

## Cara pakai

1. Deploy seluruh isi ZIP ke root GitHub Pages atau jalankan HTTP server lokal. `index.html` wajib berada di root, dan folder `vendor/` harus ikut terunggah.
2. Pilih file video/audio dari perangkat.
3. Untuk uji stabilitas pertama di iPhone, pilih **Dialog ringan** (default), lalu **Jalankan**. Ini adalah pratinjau EQ lokal tanpa ekspor.
4. Untuk mengekspor hasil RNNoise, pilih **Dialog RNNoise · ekspor**. Mode ini menggunakan FFmpeg dan tetap bisa gagal pada perangkat dengan memori terbatas.
5. Untuk mengisolasi vokal lagu, pilih **Vokal lagu · HTDemucs**. Di iPhone akan ada persetujuan khusus sebelum pemrosesan berat. Proses ini tidak real-time.

## Keterbatasan yang belum diselesaikan

- Tidak ada pengujian langsung di iPhone 13 Safari/Chrome. Browser bisa tetap refresh jika model HTDemucs membutuhkan memori di luar kapasitas proses WebKit.
- Audio video masih diekstrak sebagai PCM penuh; untuk video >1 jam perlu Fix 2 dengan chunk streaming / metode backend.
- Mode Dialog ringan menggunakan EQ dan kompresor, **tidak** memisahkan vokal dan musik. Modus ini hanya membuat ucapan berpotensi lebih jelas.
- Pemisahan musik sambil langsung memutar video dengan AI belum tersedia; ini membutuhkan tahap pengembangan berikutnya.
- MOV/HEVC, beberapa video 4K, dan format lainnya dapat gagal diekstrak atau diekspor oleh FFmpeg WebAssembly.
- Perangkat iOS memiliki anggaran memori WebAssembly yang tidak tetap. Menghentikan Worker tidak menjamin sistem melepaskan seluruh RAM seketika.
- Unduhan GitHub Pages memerlukan koneksi awal; ini bukan versi HTML tunggal offline.

## File terkait

- `index.html`: UI + peringatan perangkat
- `app.js`: pemutar langsung, pekerjaan bertahap, pembatalan, diagnostik
- `worker.js`: pekerjaan FFmpeg terpisah
- `demucs-worker.js`: mesin HTDemucs terpisah
- `separation.js`: pemisahan PCM oleh HTDemucs
- `vendor/`: aset semula, tanpa mengubah binari model/FFmpeg

## Pemulihan versi sebelumnya

ZIP asli Google Drive `saring-suara-pages.zip` tidak diubah. Simpan sebagai cadangan sebelum mengganti berkas pada repository.
