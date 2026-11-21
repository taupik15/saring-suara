# Saring Suara — Fix 1.1 (Patch Kecil)

**Basis wajib:** proyek **Saring Suara Fix 1** (ZIP tanggal 21 November 2026).

Patch ini sengaja hanya memuat file yang berubah. **Jangan hapus file asli** `worker.js`, `demucs-worker.js`, `separation.js`, atau `vendor/`: jalur ekspor dan desktop masih memakai berkas tersebut.

## Perubahan

1. Mode default `Fokus suara stereo · langsung diputar` memakai `AudioWorklet` dan masker spektral mid/side stereo. Ia membaca audio saat video diputar, tanpa mendekode seluruh video di depan, tanpa FFmpeg/HTDemucs atau upload server.
2. Kontrol kekuatan peredaman (0–100%) dan tombol bandingkan dengan sumber asli menggunakan jalur audio dengan latensi sama.
3. Di iPhone, opsi HTDemucs diberi status tidak tersedia dan dinonaktifkan. Ini **mencegah jalur yang sebelumnya terbukti membuat tab refresh**, bukan membuktikan semua masalah iOS hilang.
4. Mode lama `Dialog ringan · EQ saja` dan `Dialog RNNoise · ekspor` masih tersedia.
5. Kalau AudioWorklet gagal dimuat, preview beralih ke EQ dan menampilkan kesalahan tanpa mencoba model berat.
6. Cleanup `AudioContext`, `AudioWorkletNode`, serta URL objek saat ganti mode/file tetap dilakukan.

## Perbedaan penting

**Bukan AI pemisah musik.** Algoritme ini mengurangi bagian audio yang tidak dominan di saluran tengah stereo. Dialog di tengah dengan musik tersebar di kiri dan kanan berpeluang membaik. Musik yang juga berada di tengah atau rekaman mono **tidak akan dapat dipisahkan** dengan metode ini. Dengan demikian, **penghilangan musik total tidak dijanjikan**. Belum ada pemrosesan AI real-time berkualitas HTDemucs pada iPhone dalam patch ini.

Hasil juga **tidak diekspor**. Untuk video panjang, pemrosesan live tidak mengharuskan membaca seluruh file menjadi PCM, tetapi performa aktual di iPhone perlu diuji.

## Instalasi ke GitHub Codespaces

1. Unduh ZIP patch Fix 1.1 dan letakkan di root repo `saring-suara` yang **sudah memakai Fix 1**.
2. Jalankan `unzip -o Saring-Suara-Fix1_1-Patch.zip`.
3. `git add . && git commit -m 'Fix 1.1: live stereo center isolation' && git push origin main`
4. Buka GitHub Pages di iPhone, tekan `Jalankan`, bandingkan suara asli/teredam.

## File patch

- `index.html`: menu & penjelasan yang akurat.
- `app.js`: jalur pemutar baru, guard di iOS, kontrol pemrosesan.
- `voice-worklet.js`: DSP pemisahan pusat stereo 1024-point STFT overlap-add, peredaman mask frekuensi, mixing latensi sama.
- `tests/worklet-test.cjs`: tes DSP sintetis.
- `QA_FIX1_1.md`: apa yang sudah dan belum diverifikasi.
