# QA — Fix 1.1

## Pemeriksaan yang dijalankan

- PASS: `node --check app.js` dan `node --check voice-worklet.js` (Node 22).
- PASS: `node tests/worklet-test.cjs`, menggunakan 2 detik sinyal sintetis stereo. Suara sinus 440 Hz di tengah dipertahankan (~1.00 relatif terhadap kanal tengah asli) dan dua komponen musik 1100/1500 Hz yang tersebar di sisi teredam menjadi ~0.07 relatif terhadap kanal tengah asli (~23 dB peningkatan rasio suara/musik pada **sinyal tes buatan**, bukan benchmark rekaman nyata).
- PASS: simulasi input mono tidak menghasilkan NaN.
- PASS: pemeriksaan headless Chromium via `set_content`: mode default baru, HTDemucs nonaktif untuk user agent iPhone, pembuatan player, kontrol intensitas, penggantian mode, fallback EQ tanpa AudioWorklet, tidak ada uncaught page errors.
- PASS: tombol dan pilihan ekspor lama tetap ada di HTML/JS.

## Belum diuji

- Eksekusi AudioWorklet aktual di iPhone 13 Safari/Chrome.
- AudioWorklet sesungguhnya di browser Chromium dalam lingkungan ini. Navigasi HTTP/file Chromium ditolak oleh lingkungan pengujian (`ERR_BLOCKED_BY_ADMINISTRATOR`); uji `set_content` tidak mengaktifkan AudioWorklet.
- Kualitas pada musik asli, mono, film dengan dialog dan scoring bercampur, klip MOV/HEVC, durasi panjang.
- FFmpeg/Demucs desktop dan ekspor file di versi ini (berkas lama tidak diubah).

## Kesimpulan

Patch menghindari jalur load HTDemucs yang diketahui crash pada iPhone. AudioWorklet berbasis DSP sengaja ditawarkan sebagai percobaan ringan, bukan solusi AI yang menghilangkan musik seluruhnya. Uji langsung di perangkat tetap diperlukan.
