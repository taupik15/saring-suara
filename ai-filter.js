/* Fix 1.5: optional DeepFilterNet3 speech enhancement (WebAssembly), lazy loaded.
 * Audio stays inside the browser. Model/runtime bytes may need a first download.
 * Existing stereo DSP remains the default; failures restore the dry DSP route.
 * Runtime: deepfilternet3-noise-filter v1.3.0 (fallback v1.2.1), Apache-2.0 OR MIT.
 */
'use strict';
(() => {
  // Fix 1.5.1: only load self-hosted AI assets from this GitHub Pages origin.
  // External ESM imports / vendor CDN fetches failed on some iPhone browsers.
  const SETUP_HELP = 'Aset AI belum terpasang di website. Jalankan GitHub Actions → Install Saring Suara AI Assets → Run workflow, lalu muat ulang halaman.';

  async function installedAssets() {
    const url = new URL('./vendor-ai/manifest.json', document.baseURI).href;
    let response;
    try { response = await fetch(url, {cache:'no-store'}); }
    catch (error) { throw Error('Tidak dapat memeriksa aset lokal. ' + (error?.message || 'Koneksi gagal.')); }
    if (!response.ok) throw Error(SETUP_HELP + ' (manifest HTTP ' + response.status + ')');
    let info;
    try { info = await response.json(); }
    catch (_) { throw Error('Manifest AI tidak valid. Jalankan ulang workflow pemasangan AI.'); }
    if (info?.engine !== 'deepfilternet3' || !['v2','v3'].includes(info.version) || !info.package) {
      throw Error('Versi aset AI tidak dikenal. Jalankan ulang workflow pemasangan AI.');
    }
    return {base: new URL('./vendor-ai/', document.baseURI).href.replace(/\/$/, ''), info};
  }

  async function loadLocalModule() {
    try {
      // Bundle is built by the GitHub Action, not imported from a foreign CDN.
      return await import('./vendor-ai/dfn3.bundle.js');
    } catch (error) {
      throw Error('Modul AI lokal gagal dimuat. Jalankan ulang GitHub Action pemasangan aset AI. Detail: ' + (error?.message || String(error)));
    }
  }

  function create({context, upstream, downstream, onStatus, onFailure}) {
    let processor = null, node = null, pending = null;
    let desired = false, connected = false, destroyed = false, level = 50;

    function routeDry() {
      if (destroyed) return;
      // Avoid parallel output paths and doubling audio on toggle.
      try { upstream.disconnect(); } catch (_) {}
      if (node) {try {node.disconnect();} catch (_) {}}
      upstream.connect(downstream);
      connected = false;
    }
    function routeAI() {
      if (destroyed || !node) return;
      try { upstream.disconnect(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
      upstream.connect(node);
      node.connect(downstream);
      connected = true;
    }
    function report(message) { if (!destroyed) onStatus(message); }
    async function initialize() {
      try {
        report('Memuat DeepFilterNet3 dari aset lokal GitHub Pages…');
        if (context.sampleRate !== 48000) {
          throw Error('AI membutuhkan AudioContext 48 kHz; browser ini memakai ' + context.sampleRate + ' Hz.');
        }
        if (!context.audioWorklet || typeof WebAssembly === 'undefined' || typeof AudioWorkletNode === 'undefined') {
          throw Error('Safari tidak menyediakan AudioWorklet / WebAssembly yang dibutuhkan.');
        }
        const {base} = await installedAssets();
        if (destroyed || !desired) return;
        report('Aset AI lokal ditemukan. Memuat mesin DeepFilterNet3…');
        const {DeepFilterNet3Core} = await loadLocalModule();
        if (typeof DeepFilterNet3Core !== 'function') throw Error('Modul AI tidak cocok.');
        if (destroyed || !desired) return;
        const candidate = new DeepFilterNet3Core({
          sampleRate: 48000,
          noiseReductionLevel: level,
          assetConfig: {cdnUrl: base}
        });
        processor = candidate;
        report('Membaca bobot AI dan WebAssembly dari GitHub Pages…');
        try { await candidate.initialize(); }
        catch (error) {throw Error('Gagal memuat model/WASM lokal. Periksa vendor-ai/v*/pkg/df_bg.wasm dan vendor-ai/v*/models/DeepFilterNet3_onnx.tar.gz. Detail: ' + (error?.message || String(error)));}
        if (destroyed || !desired) return;
        report('Menyiapkan AudioWorklet AI…');
        const ready = await candidate.createAudioWorkletNode(context);
        if (destroyed || !desired) { try {ready.disconnect();} catch (_) {} return; }
        node = ready;
        node.onprocessorerror = () => {
          if (destroyed) return;
          desired = false;
          routeDry();
          report('Pemrosesan AI berhenti, audio kembali ke filter stereo.');
          onFailure(Error('AudioWorklet DeepFilterNet3 terhenti.'));
        };
        candidate.setSuppressionLevel(level);
        routeAI();
        report('AI DeepFilterNet3 aktif dari aset lokal. Uji apakah suara berubah dan video tetap lancar; sisa musik mungkin terdengar.');
      } catch (error) {
        if (destroyed) return;
        desired = false;
        routeDry();
        report('AI gagal dimuat. Filter stereo tetap berjalan. ' + (error?.message || String(error)));
        onFailure(error);
      } finally {
        pending = null;
        if (!desired && processor) {
          try {processor.destroy();} catch (_) {}
          processor = null;node = null;
        }
      }
    }
    function enable(enabled) {
      if (destroyed) return;
      desired = !!enabled;
      if (!desired) {
        routeDry();
        if (processor && !pending) {
          try {processor.destroy();} catch (_) {}
          processor = null;node = null;
        }
        report('AI nonaktif. Pemutaran memakai filter stereo/musik tengah.');
      } else if (node) {
        routeAI();
        processor?.setSuppressionLevel(level);
        report('AI DeepFilterNet3 terhubung kembali.');
      } else if (!pending) {
        pending = initialize();
      }
    }
    function setLevel(next) {
      level = Math.round(Math.max(0,Math.min(100,Number(next) || 0)));
      if (processor && node) processor.setSuppressionLevel(level);
    }
    function destroy() {
      if (destroyed) return;
      desired = false;
      try { upstream.disconnect(); } catch (_) {}
      if (node) {try {node.disconnect();} catch (_) {}}
      if (processor) {try {processor.destroy();} catch (_) {}}
      processor = null;node = null;destroyed = true;
    }
    return {enable,setLevel,destroy,get active(){return connected;}};
  }

  window.SaringAI = Object.freeze({create});
})();
