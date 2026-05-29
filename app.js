// ============================================================
// ショート動画エディタ - app.js
// ============================================================

const state = {
  clips: [],
  overlays: [],
  bgm: null,
  bgmVolume: 0.5,
  selectedClipId: null,
  isPlaying: false,
  playbackOffset: 0,
  playStartWallTime: 0,
  audioCtx: null,
  bgmSource: null,
  bgmGain: null,
};

let clipColorIndex = 0;
const CLIP_COLORS = ['#7c5cfc','#5c9cfc','#5cccfc','#5cfc9c','#fcd05c','#fc7c5c','#c05cfc','#fc5c9c'];
let ffmpeg = null;
let ffmpegLoaded = false;

const dom = {
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  clipList: document.getElementById('clip-list'),
  trimPanel: document.getElementById('trim-panel'),
  trimIn: document.getElementById('trim-in'),
  trimOut: document.getElementById('trim-out'),
  trimDuration: document.getElementById('trim-duration'),
  trimInSlider: document.getElementById('trim-in-slider'),
  trimOutSlider: document.getElementById('trim-out-slider'),
  bgmDropZone: document.getElementById('bgm-drop-zone'),
  bgmInput: document.getElementById('bgm-input'),
  bgmInfo: document.getElementById('bgm-info'),
  bgmName: document.getElementById('bgm-name'),
  btnRemoveBgm: document.getElementById('btn-remove-bgm'),
  bgmVolume: document.getElementById('bgm-volume'),
  bgmVolumeLabel: document.getElementById('bgm-volume-label'),
  canvas: document.getElementById('preview-canvas'),
  placeholder: document.getElementById('preview-placeholder'),
  btnPlay: document.getElementById('btn-play'),
  btnRewind: document.getElementById('btn-rewind'),
  btnForward: document.getElementById('btn-forward'),
  timecode: document.getElementById('timecode'),
  videoTrack: document.getElementById('video-track'),
  audioTrack: document.getElementById('audio-track'),
  bgmTrackBar: document.getElementById('bgm-track-bar'),
  bgmTrackLabel: document.getElementById('bgm-track-label'),
  playhead: document.getElementById('playhead'),
  overlayText: document.getElementById('overlay-text'),
  overlayStart: document.getElementById('overlay-start'),
  overlayEnd: document.getElementById('overlay-end'),
  overlayFontsize: document.getElementById('overlay-fontsize'),
  overlayColor: document.getElementById('overlay-color'),
  overlayBgcolor: document.getElementById('overlay-bgcolor'),
  overlayBold: document.getElementById('overlay-bold'),
  btnAddOverlay: document.getElementById('btn-add-overlay'),
  overlayList: document.getElementById('overlay-list'),
  btnExport: document.getElementById('btn-export'),
  exportModal: document.getElementById('export-modal'),
  progressBar: document.getElementById('progress-bar'),
  progressLabel: document.getElementById('progress-label'),
  exportStatusText: document.getElementById('export-status-text'),
  ffmpegStatus: document.getElementById('ffmpeg-status'),
  thumbVideo: document.getElementById('thumb-video'),
};
const ctx = dom.canvas.getContext('2d');

function genId() { return Math.random().toString(36).slice(2, 9); }
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function getTotalDuration() { return state.clips.reduce((acc, c) => acc + (c.trimOut - c.trimIn), 0); }
function getClipAtTime(globalTime) {
  let elapsed = 0;
  for (const clip of state.clips) {
    const dur = clip.trimOut - clip.trimIn;
    if (globalTime < elapsed + dur) return { clip, localTime: clip.trimIn + (globalTime - elapsed) };
    elapsed += dur;
  }
  return null;
}

const videoElements = {};
function getVideoEl(clipId) {
  if (!videoElements[clipId]) {
    const v = document.createElement('video');
    v.preload = 'auto'; v.style.display = 'none'; v.playsInline = true;
    document.body.appendChild(v);
    videoElements[clipId] = v;
  }
  return videoElements[clipId];
}
function releaseVideoEl(clipId) {
  if (videoElements[clipId]) { videoElements[clipId].src = ''; videoElements[clipId].remove(); delete videoElements[clipId]; }
}

function generateThumbnail(clip) {
  return new Promise((resolve) => {
    const v = dom.thumbVideo;
    v.src = clip.objectURL;
    v.currentTime = 1.0;
    const onSeeked = () => {
      const c = document.createElement('canvas');
      c.width = 96; c.height = 54;
      c.getContext('2d').drawImage(v, 0, 0, 96, 54);
      v.removeEventListener('seeked', onSeeked); v.src = '';
      resolve(c.toDataURL('image/jpeg', 0.6));
    };
    const onError = () => { v.removeEventListener('error', onError); v.removeEventListener('seeked', onSeeked); resolve(''); };
    v.addEventListener('seeked', onSeeked, { once: true });
    v.addEventListener('error', onError, { once: true });
  });
}

dom.dropZone.addEventListener('click', () => dom.fileInput.click());
dom.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropZone.classList.add('dragover'); });
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('dragover'));
dom.dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dom.dropZone.classList.remove('dragover');
  handleFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('video/')));
});
dom.fileInput.addEventListener('change', () => { handleFiles([...dom.fileInput.files]); dom.fileInput.value = ''; });

async function handleFiles(files) {
  for (const file of files) {
    if (file.size > 300 * 1024 * 1024) { alert(`"${file.name}" は300MBを超えています。`); continue; }
    const objectURL = URL.createObjectURL(file);
    const duration = await getVideoDuration(objectURL);
    const clip = { id: genId(), name: file.name.replace(/\.[^.]+$/, ''), file, objectURL, duration, trimIn: 0, trimOut: duration, color: CLIP_COLORS[clipColorIndex++ % CLIP_COLORS.length], thumb: '' };
    getVideoEl(clip.id).src = objectURL;
    state.clips.push(clip);
    clip.thumb = await generateThumbnail(clip);
    renderClipList(); renderTimeline(); updateExportBtn();
  }
}

function getVideoDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.src = url;
    v.onloadedmetadata = () => resolve(v.duration || 0);
    v.onerror = () => resolve(0);
  });
}

function renderClipList() {
  dom.clipList.innerHTML = '';
  state.clips.forEach((clip) => {
    const item = document.createElement('div');
    item.className = 'clip-item' + (clip.id === state.selectedClipId ? ' selected' : '');
    item.dataset.id = clip.id;
    item.innerHTML = `<img class="clip-thumb" src="${clip.thumb || ''}" alt=""><div class="clip-info"><div class="clip-name" title="${clip.name}">${clip.name}</div><div class="clip-dur">${(clip.trimOut - clip.trimIn).toFixed(1)}秒</div></div><button class="btn-icon" data-del="${clip.id}" title="削除">&#10005;</button>`;
    item.addEventListener('click', (e) => { if (e.target.dataset.del) return; selectClip(clip.id); });
    item.querySelector('[data-del]').addEventListener('click', (e) => { e.stopPropagation(); removeClip(clip.id); });
    dom.clipList.appendChild(item);
  });
  dom.placeholder.style.display = state.clips.length ? 'none' : 'flex';
}

function selectClip(id) {
  state.selectedClipId = id; renderClipList();
  const clip = state.clips.find(c => c.id === id);
  if (clip) showTrimPanel(clip);
}

function removeClip(id) {
  const idx = state.clips.findIndex(c => c.id === id);
  if (idx === -1) return;
  URL.revokeObjectURL(state.clips[idx].objectURL); releaseVideoEl(id); state.clips.splice(idx, 1);
  if (state.selectedClipId === id) { state.selectedClipId = null; dom.trimPanel.style.display = 'none'; }
  renderClipList(); renderTimeline(); updateExportBtn();
}

function showTrimPanel(clip) {
  dom.trimPanel.style.display = 'block';
  dom.trimIn.value = clip.trimIn.toFixed(1); dom.trimOut.value = clip.trimOut.toFixed(1);
  dom.trimDuration.textContent = (clip.trimOut - clip.trimIn).toFixed(1) + ' 秒';
  dom.trimInSlider.max = clip.duration; dom.trimOutSlider.max = clip.duration;
  dom.trimInSlider.value = clip.trimIn; dom.trimOutSlider.value = clip.trimOut;
}

function updateTrimFromInputs(clip) {
  let inVal = Math.max(0, Math.min(parseFloat(dom.trimIn.value) || 0, clip.duration));
  let outVal = Math.max(inVal + 0.1, Math.min(parseFloat(dom.trimOut.value) || clip.duration, clip.duration));
  clip.trimIn = inVal; clip.trimOut = outVal;
  dom.trimIn.value = inVal.toFixed(1); dom.trimOut.value = outVal.toFixed(1);
  dom.trimDuration.textContent = (outVal - inVal).toFixed(1) + ' 秒';
  dom.trimInSlider.value = inVal; dom.trimOutSlider.value = outVal;
  renderClipList(); renderTimeline();
}

dom.trimIn.addEventListener('change', () => { const c = state.clips.find(c => c.id === state.selectedClipId); if (c) updateTrimFromInputs(c); });
dom.trimOut.addEventListener('change', () => { const c = state.clips.find(c => c.id === state.selectedClipId); if (c) updateTrimFromInputs(c); });
dom.trimInSlider.addEventListener('input', () => { const c = state.clips.find(c => c.id === state.selectedClipId); if (!c) return; dom.trimIn.value = dom.trimInSlider.value; updateTrimFromInputs(c); });
dom.trimOutSlider.addEventListener('input', () => { const c = state.clips.find(c => c.id === state.selectedClipId); if (!c) return; dom.trimOut.value = dom.trimOutSlider.value; updateTrimFromInputs(c); });

dom.bgmDropZone.addEventListener('click', () => dom.bgmInput.click());
dom.bgmInput.addEventListener('change', () => { if (dom.bgmInput.files[0]) loadBGM(dom.bgmInput.files[0]); dom.bgmInput.value = ''; });
dom.btnRemoveBgm.addEventListener('click', () => { state.bgm = null; dom.bgmInfo.style.display = 'none'; dom.bgmDropZone.style.display = 'block'; dom.bgmTrackBar.style.display = 'none'; stopBGMPlayback(); });
dom.bgmVolume.addEventListener('input', () => { state.bgmVolume = parseFloat(dom.bgmVolume.value); dom.bgmVolumeLabel.textContent = Math.round(state.bgmVolume * 100) + '%'; if (state.bgmGain) state.bgmGain.gain.value = state.bgmVolume; });

async function loadBGM(file) {
  ensureAudioCtx();
  try {
    const audioBuffer = await state.audioCtx.decodeAudioData(await file.arrayBuffer());
    state.bgm = { file, name: file.name, audioBuffer };
    dom.bgmName.textContent = file.name;
    dom.bgmInfo.style.display = 'flex'; dom.bgmInfo.style.alignItems = 'center'; dom.bgmInfo.style.gap = '8px';
    dom.bgmDropZone.style.display = 'none';
    dom.bgmTrackBar.style.display = 'flex'; dom.bgmTrackLabel.textContent = file.name.replace(/\.[^.]+$/, '');
  } catch { alert('音楽ファイルの読み込みに失敗しました。対応フォーマット: MP3, AAC, WAV'); }
}

function ensureAudioCtx() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.bgmGain = state.audioCtx.createGain();
    state.bgmGain.gain.value = state.bgmVolume;
    state.bgmGain.connect(state.audioCtx.destination);
  }
}
function playBGMAt(offset) {
  if (!state.bgm || !state.audioCtx) return;
  stopBGMPlayback();
  const src = state.audioCtx.createBufferSource();
  src.buffer = state.bgm.audioBuffer; src.loop = true; src.connect(state.bgmGain);
  src.start(0, offset % state.bgm.audioBuffer.duration);
  state.bgmSource = src;
}
function stopBGMPlayback() { if (state.bgmSource) { try { state.bgmSource.stop(); } catch {} state.bgmSource = null; } }

const TIMELINE_PX_PER_SEC = 60;
function renderTimeline() {
  dom.videoTrack.innerHTML = '';
  const total = getTotalDuration();
  const trackWidth = Math.max(total * TIMELINE_PX_PER_SEC, 400);
  dom.videoTrack.style.width = trackWidth + 'px'; dom.audioTrack.style.width = trackWidth + 'px';
  state.clips.forEach((clip, idx) => {
    const dur = clip.trimOut - clip.trimIn;
    const el = document.createElement('div');
    el.className = 'timeline-clip' + (clip.id === state.selectedClipId ? ' selected' : '');
    el.style.width = (dur * TIMELINE_PX_PER_SEC) + 'px'; el.style.background = clip.color; el.style.color = '#fff';
    el.dataset.id = clip.id; el.dataset.idx = idx; el.textContent = clip.name;
    el.title = `${clip.name} (${dur.toFixed(1)}s)`; el.draggable = true;
    el.addEventListener('click', () => selectClip(clip.id));
    el.addEventListener('dragstart', onDragStart); el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave); el.addEventListener('drop', onDrop); el.addEventListener('dragend', onDragEnd);
    dom.videoTrack.appendChild(el);
  });
  updatePlayhead(state.playbackOffset);
}

let dragSrcIdx = null;
function onDragStart(e) { dragSrcIdx = parseInt(e.currentTarget.dataset.idx); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragSrcIdx)); }
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onDrop(e) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  const toIdx = parseInt(e.currentTarget.dataset.idx);
  if (dragSrcIdx === null || dragSrcIdx === toIdx) return;
  const [moved] = state.clips.splice(dragSrcIdx, 1); state.clips.splice(toIdx, 0, moved);
  renderClipList(); renderTimeline();
}
function onDragEnd(e) { e.currentTarget.classList.remove('drag-over'); dragSrcIdx = null; }

function updatePlayhead(offset) {
  const total = getTotalDuration();
  const trackWidth = Math.max(total * TIMELINE_PX_PER_SEC, 400);
  dom.playhead.style.left = (total > 0 ? (offset / total) * trackWidth : 0) + 'px';
}

document.getElementById('timeline-scroll-area').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const total = getTotalDuration();
  const trackWidth = Math.max(total * TIMELINE_PX_PER_SEC, 400);
  seekTo(Math.max(0, Math.min((e.clientX - rect.left) / trackWidth * total, total)));
});

let rafId = null;
dom.btnPlay.addEventListener('click', () => {
  if (state.clips.length === 0) return;
  ensureAudioCtx(); state.audioCtx.resume();
  state.isPlaying ? pausePlayback() : startPlayback();
});
dom.btnRewind.addEventListener('click', () => seekTo(0));
dom.btnForward.addEventListener('click', () => seekTo(Math.min(state.playbackOffset + 5, getTotalDuration())));

function startPlayback() {
  if (state.clips.length === 0) return;
  if (state.playbackOffset >= getTotalDuration()) state.playbackOffset = 0;
  state.isPlaying = true; state.playStartWallTime = performance.now(); dom.btnPlay.textContent = '⏸';
  const result = getClipAtTime(state.playbackOffset);
  if (result) getVideoEl(result.clip.id).currentTime = result.localTime;
  if (state.bgm) playBGMAt(state.playbackOffset);
  rafId = requestAnimationFrame(renderLoop);
}

function pausePlayback() {
  state.isPlaying = false; state.playbackOffset += (performance.now() - state.playStartWallTime) / 1000;
  dom.btnPlay.textContent = '▶'; if (rafId) { cancelAnimationFrame(rafId); rafId = null; } stopBGMPlayback();
}

function seekTo(time) {
  const wasPlaying = state.isPlaying; if (wasPlaying) pausePlayback();
  state.playbackOffset = time; updatePlayhead(time);
  const result = getClipAtTime(time);
  if (result) {
    const v = getVideoEl(result.clip.id); v.src = result.clip.objectURL; v.currentTime = result.localTime;
    v.addEventListener('seeked', () => drawFrame(time, result.clip, v), { once: true });
  } else { ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height); }
  dom.timecode.textContent = `${formatTime(time)} / ${formatTime(getTotalDuration())}`;
  if (wasPlaying) startPlayback();
}

let lastClipId = null, frameCount = 0;
function renderLoop() {
  if (!state.isPlaying) return;
  const globalTime = state.playbackOffset + (performance.now() - state.playStartWallTime) / 1000;
  const total = getTotalDuration();
  if (globalTime >= total) { state.playbackOffset = total; state.isPlaying = false; dom.btnPlay.textContent = '▶'; stopBGMPlayback(); dom.timecode.textContent = `${formatTime(total)} / ${formatTime(total)}`; updatePlayhead(total); return; }
  const result = getClipAtTime(globalTime);
  if (result) {
    const v = getVideoEl(result.clip.id);
    if (result.clip.id !== lastClipId) { if (lastClipId) getVideoEl(lastClipId).pause(); v.src = result.clip.objectURL; v.currentTime = result.localTime; v.play().catch(() => {}); lastClipId = result.clip.id; }
    if (++frameCount % 60 === 0 && Math.abs(v.currentTime - result.localTime) > 0.3) v.currentTime = result.localTime;
    drawFrame(globalTime, result.clip, v);
  }
  dom.timecode.textContent = `${formatTime(globalTime)} / ${formatTime(total)}`; updatePlayhead(globalTime);
  rafId = requestAnimationFrame(renderLoop);
}

function drawFrame(globalTime, clip, videoEl) {
  const W = dom.canvas.width, H = dom.canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (videoEl.readyState >= 2) {
    const vw = videoEl.videoWidth || 1, vh = videoEl.videoHeight || 1;
    const scale = Math.min(W / vw, H / vh);
    ctx.drawImage(videoEl, (W - vw * scale) / 2, (H - vh * scale) / 2, vw * scale, vh * scale);
  }
  drawOverlays(globalTime, W, H);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawOverlays(globalTime, W, H) {
  state.overlays.forEach((ov) => {
    if (globalTime < ov.startTime || globalTime >= ov.endTime) return;
    const fontSize = ov.fontSize || 40;
    ctx.font = `${ov.bold ? 'bold ' : ''}${fontSize}px 'Noto Sans JP', sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const textW = ctx.measureText(ov.text).width, pad = 10;
    const x = W / 2;
    const y = ov.posY === 'top' ? fontSize + pad * 2 : ov.posY === 'center' ? H / 2 : H - fontSize - pad * 2;
    ctx.fillStyle = hexToRgba(ov.bgColor || '#000000', 0.6);
    ctx.beginPath(); ctx.roundRect(x - textW / 2 - pad, y - fontSize / 2 - pad / 2, textW + pad * 2, fontSize + pad, 6); ctx.fill();
    ctx.fillStyle = ov.color || '#ffffff'; ctx.fillText(ov.text, x, y);
  });
}

let selectedPosition = 'bottom';
document.querySelectorAll('.pos-btn').forEach(btn => {
  btn.addEventListener('click', () => { document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); selectedPosition = btn.dataset.pos; });
});

dom.btnAddOverlay.addEventListener('click', () => {
  const text = dom.overlayText.value.trim(); if (!text) { dom.overlayText.focus(); return; }
  state.overlays.push({ id: genId(), text, startTime: parseFloat(dom.overlayStart.value) || 0, endTime: parseFloat(dom.overlayEnd.value) || 3, posY: selectedPosition, fontSize: parseInt(dom.overlayFontsize.value) || 40, color: dom.overlayColor.value, bgColor: dom.overlayBgcolor.value, bold: dom.overlayBold.checked });
  dom.overlayText.value = ''; renderOverlayList();
});

function renderOverlayList() {
  dom.overlayList.innerHTML = '';
  state.overlays.forEach((ov) => {
    const item = document.createElement('div'); item.className = 'overlay-item';
    item.innerHTML = `<div class="overlay-preview" style="color:${ov.color};background:${hexToRgba(ov.bgColor,'0.7')};padding:2px 6px;border-radius:4px;font-size:12px;${ov.bold?'font-weight:bold':''}">${ov.text}</div><span class="overlay-time">${ov.startTime.toFixed(1)}s – ${ov.endTime.toFixed(1)}s</span><button class="btn-icon" data-del-ov="${ov.id}">&#10005;</button>`;
    item.querySelector('[data-del-ov]').addEventListener('click', () => { state.overlays = state.overlays.filter(o => o.id !== ov.id); renderOverlayList(); });
    dom.overlayList.appendChild(item);
  });
}

dom.btnExport.addEventListener('click', startExport);
function updateExportBtn() { dom.btnExport.disabled = state.clips.length === 0; }

async function startExport() {
  if (state.clips.length === 0) return;
  dom.exportModal.style.display = 'flex'; setExportStatus('FFmpegを読み込んでいます...', 0);
  try {
    await ensureFFmpeg(); setExportStatus('動画ファイルを処理しています...', 5);
    const W = 1080, H = 1920, trimmedFiles = [];
    for (let i = 0; i < state.clips.length; i++) {
      const clip = state.clips[i], inFile = `input_${i}.mp4`, outFile = `trimmed_${i}.mp4`;
      setExportStatus(`クリップ ${i+1}/${state.clips.length} を処理中...`, 5 + (i / state.clips.length) * 50);
      ffmpeg.FS('writeFile', inFile, new Uint8Array(await clip.file.arrayBuffer()));
      await ffmpeg.run('-ss', String(clip.trimIn), '-i', inFile, '-t', String(clip.trimOut - clip.trimIn), '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', outFile);
      ffmpeg.FS('unlink', inFile); trimmedFiles.push(outFile);
    }
    setExportStatus('クリップを結合しています...', 60);
    ffmpeg.FS('writeFile', 'list.txt', new TextEncoder().encode(trimmedFiles.map(f => `file '${f}'`).join('\n')));
    await ffmpeg.run('-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-y', 'merged.mp4');
    trimmedFiles.forEach(f => { try { ffmpeg.FS('unlink', f); } catch {} }); ffmpeg.FS('unlink', 'list.txt');
    let finalFile = 'merged.mp4';
    if (state.bgm) {
      setExportStatus('BGMを合成しています...', 75);
      const ext = state.bgm.name.split('.').pop().toLowerCase(), bgmFile = `bgm.${ext}`;
      ffmpeg.FS('writeFile', bgmFile, new Uint8Array(await state.bgm.file.arrayBuffer()));
      await ffmpeg.run('-i', 'merged.mp4', '-i', bgmFile, '-filter_complex', `[0:a][1:a]amix=inputs=2:duration=first:weights=1 ${state.bgmVolume.toFixed(2)}`, '-c:v', 'copy', '-y', 'final.mp4');
      ffmpeg.FS('unlink', 'merged.mp4'); ffmpeg.FS('unlink', bgmFile); finalFile = 'final.mp4';
    }
    setExportStatus('ダウンロードを準備中...', 95);
    const output = ffmpeg.FS('readFile', finalFile); ffmpeg.FS('unlink', finalFile);
    const url = URL.createObjectURL(new Blob([output.buffer], { type: 'video/mp4' }));
    Object.assign(document.createElement('a'), { href: url, download: 'short-video.mp4' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setExportStatus('完了！', 100); setTimeout(() => { dom.exportModal.style.display = 'none'; }, 1500);
  } catch (err) { console.error('Export error:', err); alert('エクスポートに失敗しました: ' + err.message); dom.exportModal.style.display = 'none'; }
}

function setExportStatus(text, pct) { dom.exportStatusText.textContent = text; dom.progressBar.style.width = pct + '%'; dom.progressLabel.textContent = Math.round(pct) + '%'; }

async function ensureFFmpeg() {
  if (ffmpegLoaded) return;
  dom.ffmpegStatus.textContent = 'FFmpeg: 読込中...'; dom.ffmpegStatus.className = 'status-badge loading';
  await new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';
    s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
  ffmpeg = window.FFmpeg.createFFmpeg({ log: false, progress: ({ ratio }) => { dom.progressBar.style.width = (5 + ratio * 85) + '%'; dom.progressLabel.textContent = Math.round(5 + ratio * 85) + '%'; } });
  await ffmpeg.load();
  ffmpegLoaded = true; dom.ffmpegStatus.textContent = 'FFmpeg: 準備完了'; dom.ffmpegStatus.className = 'status-badge ready';
}

window.addEventListener('load', () => { setTimeout(() => ensureFFmpeg().catch(() => {}), 2000); });
renderClipList(); renderTimeline(); updateExportBtn();