const get = id => document.getElementById(id);
const file = get('file'), run = get('run'), cancel = get('cancel'), result = get('result');
const bar = document.querySelector('progress');
let worker, url;
function clearResult() {
  result.replaceChildren();
  if (url) URL.revokeObjectURL(url);
  url = null;
}
function finish(message) {
  if (worker) worker.terminate();
  worker = null;
  get('status').textContent = message;
  bar.hidden = cancel.hidden = true;
  file.disabled = document.querySelector('fieldset').disabled = false;
  run.disabled = !file.files.length;
}
get('stem').onchange = () => {
  get('dialogOptions').hidden = get('stem').value !== 'dialog';
  get('hint').hidden = get('stem').value === 'dialog';
};
file.onchange = () => {
  clearResult();
  finish('');
  const video = file.files[0]?.type.startsWith('video/');
  document.querySelector('input[value="' + (video ? 'video' : 'audio') + '"]').checked = true;
};
cancel.onclick = () => finish('Proses dibatalkan.');
run.onclick = () => {
  clearResult();
  const source = file.files[0], mode = document.querySelector('input[name=mode]:checked').value;
  try {
    worker = new Worker('worker.js');
    worker.onerror = () => finish('Mesin terhenti. Coba file lebih kecil atau muat ulang halaman.');
    worker.onmessage = ({data}) => {
      if (data.msg) return;
      if (data.error) return finish(data.error);
      if (!data.blob) {
        get('status').textContent = data.message;
        if (Number.isFinite(data.progress)) {bar.max=1; bar.value=data.progress;}
        return;
      }
      const blob = data.blob;
      url = URL.createObjectURL(blob);
      const player = document.createElement(mode);
      player.controls = true; player.src = url;
      const link = document.createElement('a');
      link.href = url; link.download = source.name.replace(/\.[^.]+$/, '') + '-' + get('stem').value + '.' + data.ext;
      link.textContent = 'Unduh ' + data.ext.toUpperCase();
      result.append(player,link);
      finish('Selesai. Hasil siap disimpan.');
    };
    file.disabled = run.disabled = document.querySelector('fieldset').disabled = true;
    cancel.hidden = bar.hidden = false; bar.removeAttribute('value');
    get('status').textContent = 'Memuat mesin suara…';
    worker.postMessage({source,mode,stem:get('stem').value,centered:get('centered').checked});
  } catch { finish('Browser gagal memulai pemrosesan.'); }
};
