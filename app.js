// ============================================================
// AI ショート動画エディタ - app.js
// ============================================================

// ---------- State ----------
const state = {
  clips: [],      // { id, name, file, objectURL, duration, trimIn, trimOut, color, thumb }
  overlays: [],   // { id, text, startTime, endTime, posY, fontSize, color, bgColor, bold }
  bgm: null,      // { file, name, audioBuffer }
  bgmVolume: 0.5,
  apiKey: localStorage.getItem('gemini_api_key') || '',
  isPlaying: false,
  playbackOffset: 0,
  playStartWallTime: 0,
  audioCtx: null,
  bgmSource: null,
  bgmGain: null,
};

const CLIP_COLORS = ['#7c5cfc','#5c9cfc','#5ccc8c','#fcb05c','#fc6c5c','#c05cfc','#5cccfc','#fc5c9c'];
let clipColorIndex = 0;
let ffmpeg = null;
let ffmpegLoaded = false;
let rafId = null;
let lastClipId = null;
let frameCount = 0;

// ---------- DOM ----------
const dom = {
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  bgmZone: document.getElementById('bgm-zone'),
  bgmInput: document.getElementById('bgm-input'),
  bgmInfo: document.getElementById('bgm-info'),
  bgmNameText: document.getElementById('bgm-name-text'),
  btnRemoveBgm: document.getElementById('btn-remove-bgm'),
  clipList: document.getElementById('clip-list'),
  editStatePanel: document.getElementById('edit-state-panel'),
  editStateList: document.getElementById('edit-state-list'),
  canvas: document.getElementById('preview-canvas'),
  placeholder: document.getElementById('preview-placeholder'),
  btnPlay: document.getElementById('btn-play'),
  btnRewind: document.getElementById('btn-rewind'),
  timecode: document.getElementById('timecode'),
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('chat-input'),
  btnSend: document.getElementById('btn-send'),
  btnApiKey: document.getElementById('btn-api-key'),
  btnExport: document.getElementById('btn-export'),
  apiModal: document.getElementById('api-modal'),
  apiKeyInput: document.getElementById('api-key-input'),
  btnSaveKey: document.getElementById('btn-save-key'),
  btnCancelKey: document.getElementById('btn-cancel-key'),
  exportModal: document.getElementById('export-modal'),
  progressBar: document.getElementById('progress-bar'),
  progressLabel: document.getElementById('progress-label'),
  exportStatusText: document.getElementById('export-status-text'),
  ffmpegStatus: document.getElementById('ffmpeg-status'),
  thumbVideo: document.getElementById('thumb-video'),
};
const ctx2d = dom.canvas.getContext('2d');

// ---------- Helpers ----------
const genId = () => Math.random().toString(36).slice(2, 9);
const formatTime = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
const getTotalDuration = () => state.clips.reduce((a, c) => a + (c.trimOut - c.trimIn), 0);
function getClipAtTime(t) {
  let elapsed = 0;
  for (const clip of state.clips) {
    const dur = clip.trimOut - clip.trimIn;
    if (t < elapsed + dur) return { clip, localTime: clip.trimIn + (t - elapsed) };
    elapsed += dur;
  }
  return null;
}
function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------- Video element pool ----------
const videoEls = {};
function getVideoEl(id) {
  if (!videoEls[id]) {
    const v = document.createElement('video');
    v.preload = 'auto'; v.style.display = 'none'; v.playsInline = true;
    document.body.appendChild(v);
    videoEls[id] = v;
  }
  return videoEls[id];
}
function releaseVideoEl(id) {
  if (videoEls[id]) { videoEls[id].src = ''; videoEls[id].remove(); delete videoEls[id]; }
}

// ---------- Thumbnail ----------
function generateThumb(clip) {
  return new Promise(resolve => {
    const v = dom.thumbVideo;
    v.src = clip.objectURL; v.currentTime = 1.0;
    v.addEventListener('seeked', () => {
      const c = document.createElement('canvas'); c.width=96; c.height=54;
      c.getContext('2d').drawImage(v,0,0,96,54);
      v.src = ''; resolve(c.toDataURL('image/jpeg',0.6));
    }, { once: true });
    v.addEventListener('error', () => { v.src=''; resolve(''); }, { once: true });
  });
}

// ---------- Upload ----------
dom.dropZone.addEventListener('click', () => dom.fileInput.click());
dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('dragover'); });
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('dragover'));
dom.dropZone.addEventListener('drop', e => { e.preventDefault(); dom.dropZone.classList.remove('dragover'); handleVideoFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('video/'))); });
dom.fileInput.addEventListener('change', () => { handleVideoFiles([...dom.fileInput.files]); dom.fileInput.value=''; });

async function handleVideoFiles(files) {
  for (const file of files) {
    if (file.size > 300*1024*1024) { addAIMessage('⚠️ ' + file.name + ' は300MBを超えています。'); continue; }
    const objectURL = URL.createObjectURL(file);
    const duration = await getVideoDuration(objectURL);
    const clip = { id: genId(), name: file.name.replace(/\.[^.]+$/,''), file, objectURL, duration, trimIn: 0, trimOut: duration, color: CLIP_COLORS[clipColorIndex++ % CLIP_COLORS.length], thumb: '' };
    getVideoEl(clip.id).src = objectURL;
    state.clips.push(clip);
    clip.thumb = await generateThumb(clip);
    renderClipList(); renderEditState(); updateUI();
  }
}

function getVideoDuration(url) {
  return new Promise(resolve => {
    const v = document.createElement('video'); v.preload = 'metadata'; v.src = url;
    v.onloadedmetadata = () => resolve(v.duration || 0);
    v.onerror = () => resolve(0);
  });
}

// ---------- BGM ----------
dom.bgmZone.addEventListener('click', () => dom.bgmInput.click());
dom.bgmInput.addEventListener('change', () => { if (dom.bgmInput.files[0]) loadBGM(dom.bgmInput.files[0]); dom.bgmInput.value=''; });
dom.btnRemoveBgm.addEventListener('click', () => {
  state.bgm = null; dom.bgmInfo.style.display='none'; dom.bgmZone.style.display='block';
  stopBGM(); renderEditState();
});

async function loadBGM(file) {
  ensureAudioCtx();
  try {
    const ab = await state.audioCtx.decodeAudioData(await file.arrayBuffer());
    state.bgm = { file, name: file.name, audioBuffer: ab };
    dom.bgmNameText.textContent = file.name.replace(/\.[^.]+$/,'');
    dom.bgmInfo.style.display = 'flex'; dom.bgmZone.style.display = 'none';
    renderEditState();
  } catch { addAIMessage('⚠️ 音楽ファイルの読み込みに失敗しました（対応: MP3, AAC, WAV）'); }
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
  stopBGM();
  const src = state.audioCtx.createBufferSource();
  src.buffer = state.bgm.audioBuffer; src.loop = true; src.connect(state.bgmGain);
  src.start(0, offset % state.bgm.audioBuffer.duration);
  state.bgmSource = src;
}
function stopBGM() { if (state.bgmSource) { try { state.bgmSource.stop(); } catch {} state.bgmSource = null; } }

// ---------- Render clips ----------
function renderClipList() {
  dom.clipList.innerHTML = '';
  state.clips.forEach((clip, i) => {
    const dur = (clip.trimOut - clip.trimIn).toFixed(1);
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.innerHTML = `
      <div class="clip-num" style="background:${clip.color}">${i+1}</div>
      <img class="clip-thumb" src="${clip.thumb||''}" alt="">
      <div class="clip-info">
        <div class="clip-name" title="${clip.name}">${clip.name}</div>
        <div class="clip-meta">${dur}秒 使用</div>
      </div>
      <button class="btn-icon" data-del="${clip.id}" title="削除">✕</button>
    `;
    item.querySelector('[data-del]').addEventListener('click', e => {
      e.stopPropagation();
      URL.revokeObjectURL(clip.objectURL); releaseVideoEl(clip.id);
      state.clips = state.clips.filter(c => c.id !== clip.id);
      renderClipList(); renderEditState(); updateUI();
    });
    dom.clipList.appendChild(item);
  });
  dom.placeholder.style.display = state.clips.length ? 'none' : 'flex';
}

function renderEditState() {
  const hasEdits = state.overlays.length > 0 || state.bgm || state.clips.some(c => c.trimIn > 0 || c.trimOut < c.duration - 0.05);
  dom.editStatePanel.style.display = (state.clips.length && hasEdits) ? 'block' : 'none';
  dom.editStateList.innerHTML = '';

  state.clips.forEach((clip, i) => {
    if (clip.trimIn > 0 || clip.trimOut < clip.duration - 0.05) {
      const el = document.createElement('div'); el.className = 'state-item';
      el.innerHTML = `<strong>クリップ${i+1}</strong>: ${clip.trimIn.toFixed(1)}s〜${clip.trimOut.toFixed(1)}s`;
      dom.editStateList.appendChild(el);
    }
  });

  if (state.bgm) {
    const el = document.createElement('div'); el.className = 'state-item';
    el.innerHTML = `<strong>BGM</strong>: ${state.bgm.name.replace(/\.[^.]+$/,'')} (音量${Math.round(state.bgmVolume*100)}%)`;
    dom.editStateList.appendChild(el);
  }

  state.overlays.forEach(ov => {
    const el = document.createElement('div'); el.className = 'state-item';
    el.innerHTML = `<strong>テキスト</strong>: 「${ov.text}」 ${ov.startTime.toFixed(1)}s〜${ov.endTime.toFixed(1)}s`;
    dom.editStateList.appendChild(el);
  });
}

function updateUI() {
  dom.btnExport.disabled = state.clips.length === 0;
  const canSend = state.clips.length > 0 && !!state.apiKey;
  dom.btnSend.disabled = !canSend;
  dom.chatInput.placeholder = canSend
    ? '編集の要望を入力... (Enter で送信、Shift+Enter で改行)'
    : state.clips.length === 0 ? '先に動画を追加してください' : '先に API キーを設定してください (⚙ ボタン)';
}

// ---------- API Key modal ----------
dom.btnApiKey.addEventListener('click', () => {
  dom.apiKeyInput.value = state.apiKey;
  dom.apiModal.style.display = 'flex';
  setTimeout(() => dom.apiKeyInput.focus(), 50);
});
dom.btnSaveKey.addEventListener('click', () => {
  const key = dom.apiKeyInput.value.trim();
  state.apiKey = key;
  localStorage.setItem('gemini_api_key', key);
  dom.apiModal.style.display = 'none';
  updateUI();
  if (key) addAIMessage('✅ API キーを保存しました。要望を入力してください！');
});
dom.btnCancelKey.addEventListener('click', () => { dom.apiModal.style.display = 'none'; });
dom.apiModal.addEventListener('click', e => { if (e.target === dom.apiModal) dom.apiModal.style.display = 'none'; });
dom.apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') dom.btnSaveKey.click(); });

// ---------- Chat ----------
dom.chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
dom.btnSend.addEventListener('click', sendMessage);

function addUserMessage(text) {
  const div = document.createElement('div'); div.className = 'msg msg-user';
  div.innerHTML = `<div class="msg-bubble">${text.replace(/\n/g,'<br>')}</div>`;
  dom.chatMessages.appendChild(div);
  scrollChat();
}

function addAIMessage(text) {
  const div = document.createElement('div'); div.className = 'msg msg-ai';
  div.innerHTML = `<div class="msg-bubble">${text.replace(/\n/g,'<br>')}</div>`;
  dom.chatMessages.appendChild(div);
  scrollChat();
  return div;
}

function addThinking() {
  const div = document.createElement('div'); div.className = 'msg msg-ai msg-thinking';
  div.innerHTML = `<div class="msg-bubble">🤖 考えています<span class="thinking-dots"></span></div>`;
  dom.chatMessages.appendChild(div);
  scrollChat();
  return div;
}

function scrollChat() {
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

async function sendMessage() {
  const text = dom.chatInput.value.trim();
  if (!text || dom.btnSend.disabled) return;
  dom.chatInput.value = '';

  addUserMessage(text);
  dom.btnSend.disabled = true;
  const thinking = addThinking();

  try {
    const plan = await callGemini(text);
    thinking.remove();
    applyPlan(plan);

    let replyText = plan.message || '編集を適用しました！';
    replyText += '\n\nプレビューで確認して、「MP4 ダウンロード」ボタンで書き出せます。\nさらに調整が必要な場合はお気軽にどうぞ。';
    addAIMessage(replyText);
  } catch (err) {
    thinking.remove();
    let msg = '⚠️ エラーが発生しました。';
    if (err.message.includes('API_KEY') || err.message.includes('401')) {
      msg += '\nAPIキーが正しくない可能性があります。⚙ ボタンで確認してください。';
    } else if (err.message.includes('429')) {
      msg += '\nAPIの利用制限に達しました。少し待ってから再試行してください。';
    } else {
      msg += '\n詳細: ' + err.message;
    }
    addAIMessage(msg);
  }

  updateUI();
}

// ---------- Gemini API ----------
async function callGemini(userMessage) {
  if (!state.apiKey) throw new Error('APIキーが設定されていません');

  const clipInfo = state.clips.map((c, i) =>
    `- クリップ${i+1}: 「${c.name}」(元の長さ:${c.duration.toFixed(1)}秒, 現在:${c.trimIn.toFixed(1)}s〜${c.trimOut.toFixed(1)}sを使用)`
  ).join('\n');

  const overlayInfo = state.overlays.length
    ? '\n現在のテキストオーバーレイ:\n' + state.overlays.map(o => `- 「${o.text}」 ${o.startTime.toFixed(1)}s〜${o.endTime.toFixed(1)}s (${o.posY})`).join('\n')
    : '';

  const bgmInfo = state.bgm ? `\nBGM: 「${state.bgm.name}」(現在の音量: ${Math.round(state.bgmVolume*100)}%)` : '\nBGM: なし';

  const totalDur = getTotalDuration();

  const prompt = `あなたはショート動画（TikTok・Instagram Reels・YouTube Shorts用、縦型9:16）の編集AIです。
ユーザーの要望を解釈して、編集指示をJSONで返してください。

【現在の素材】
${clipInfo}${bgmInfo}${overlayInfo}
現在の動画合計時間: ${totalDur.toFixed(1)}秒

【返すJSONの形式】
{
  "clips": [
    {"index": クリップ番号(0始まり), "trimIn": 開始秒(数値), "trimOut": 終了秒(数値)}
  ],
  "clipOrder": [0,1,2,...],
  "overlays": [
    {
      "text": "表示するテキスト",
      "startTime": 開始秒(動画全体の中での時刻),
      "endTime": 終了秒,
      "posY": "top" または "center" または "bottom",
      "fontSize": 文字サイズ(デフォルト48),
      "color": "#ffffff",
      "bgColor": "#000000",
      "bold": false
    }
  ],
  "bgmVolume": 0〜1の数値,
  "message": "ユーザーへの日本語説明（何をしたか・なぜそうしたか）"
}

【ルール】
- 変更しないフィールドは省略してOK
- overlaysは現在のものを上書き（新規追加でなく全置き換え）
- clipOrderを変えるとクリップの順番が変わる
- 「全クリップを〇秒にして」などはすべてのclipsに適用する
- trimOutは必ずclipのduration以下にする
- messageは必ず返す

ユーザーの要望: ${userMessage}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${state.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
      })
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(res.status + ' ' + errBody.slice(0, 200));
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Geminiから有効な応答がありませんでした');

  return JSON.parse(raw);
}

// ---------- Apply Plan ----------
function applyPlan(plan) {
  // Reorder clips
  if (plan.clipOrder && Array.isArray(plan.clipOrder)) {
    const reordered = plan.clipOrder
      .filter(i => i >= 0 && i < state.clips.length)
      .map(i => state.clips[i]);
    if (reordered.length === state.clips.length) state.clips = reordered;
  }

  // Apply trim changes
  if (plan.clips && Array.isArray(plan.clips)) {
    plan.clips.forEach(c => {
      const clip = state.clips[c.index];
      if (!clip) return;
      if (c.trimIn !== undefined) clip.trimIn = Math.max(0, Math.min(c.trimIn, clip.duration));
      if (c.trimOut !== undefined) clip.trimOut = Math.max(clip.trimIn + 0.1, Math.min(c.trimOut, clip.duration));
    });
  }

  // Apply overlays (full replace)
  if (plan.overlays !== undefined) {
    state.overlays = (plan.overlays || []).map(ov => ({
      id: genId(),
      text: ov.text || '',
      startTime: ov.startTime || 0,
      endTime: ov.endTime || 3,
      posY: ov.posY || 'bottom',
      fontSize: ov.fontSize || 48,
      color: ov.color || '#ffffff',
      bgColor: ov.bgColor || '#000000',
      bold: ov.bold || false,
    }));
  }

  // Apply BGM volume
  if (plan.bgmVolume !== undefined) {
    state.bgmVolume = Math.max(0, Math.min(1, plan.bgmVolume));
    if (state.bgmGain) state.bgmGain.gain.value = state.bgmVolume;
  }

  // Seek to beginning
  seekTo(0);
  renderClipList();
  renderEditState();
  updateUI();
}

// ---------- Playback ----------
dom.btnPlay.addEventListener('click', () => {
  if (state.clips.length === 0) return;
  ensureAudioCtx(); state.audioCtx.resume();
  state.isPlaying ? pausePlayback() : startPlayback();
});
dom.btnRewind.addEventListener('click', () => seekTo(0));

function startPlayback() {
  if (!state.clips.length) return;
  if (state.playbackOffset >= getTotalDuration()) state.playbackOffset = 0;
  state.isPlaying = true; state.playStartWallTime = performance.now();
  dom.btnPlay.textContent = '⏸';
  const r = getClipAtTime(state.playbackOffset);
  if (r) { const v = getVideoEl(r.clip.id); v.currentTime = r.localTime; v.play().catch(()=>{}); lastClipId = r.clip.id; }
  if (state.bgm) playBGMAt(state.playbackOffset);
  rafId = requestAnimationFrame(renderLoop);
}

function pausePlayback() {
  state.isPlaying = false;
  state.playbackOffset += (performance.now() - state.playStartWallTime) / 1000;
  dom.btnPlay.textContent = '▶';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  stopBGM();
}

function seekTo(time) {
  const was = state.isPlaying; if (was) pausePlayback();
  state.playbackOffset = time;
  const r = getClipAtTime(time);
  if (r) {
    const v = getVideoEl(r.clip.id); v.src = r.clip.objectURL; v.currentTime = r.localTime;
    v.addEventListener('seeked', () => drawFrame(time, r.clip, v), { once: true });
  } else { ctx2d.clearRect(0, 0, dom.canvas.width, dom.canvas.height); }
  dom.timecode.textContent = `${formatTime(time)} / ${formatTime(getTotalDuration())}`;
  if (was) startPlayback();
}

function renderLoop() {
  if (!state.isPlaying) return;
  const globalTime = state.playbackOffset + (performance.now() - state.playStartWallTime) / 1000;
  const total = getTotalDuration();
  if (globalTime >= total) {
    state.playbackOffset = total; state.isPlaying = false; dom.btnPlay.textContent = '▶'; stopBGM();
    dom.timecode.textContent = `${formatTime(total)} / ${formatTime(total)}`; return;
  }
  const r = getClipAtTime(globalTime);
  if (r) {
    const v = getVideoEl(r.clip.id);
    if (r.clip.id !== lastClipId) {
      if (lastClipId) { const pv = getVideoEl(lastClipId); pv.pause(); }
      v.src = r.clip.objectURL; v.currentTime = r.localTime; v.play().catch(()=>{}); lastClipId = r.clip.id;
    }
    if (++frameCount % 60 === 0 && Math.abs(v.currentTime - r.localTime) > 0.3) v.currentTime = r.localTime;
    drawFrame(globalTime, r.clip, v);
  }
  dom.timecode.textContent = `${formatTime(globalTime)} / ${formatTime(total)}`;
  rafId = requestAnimationFrame(renderLoop);
}

function drawFrame(globalTime, clip, videoEl) {
  const W = dom.canvas.width, H = dom.canvas.height;
  ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, W, H);
  if (videoEl.readyState >= 2) {
    const vw = videoEl.videoWidth || 1, vh = videoEl.videoHeight || 1;
    const scale = Math.min(W/vw, H/vh);
    ctx2d.drawImage(videoEl, (W-vw*scale)/2, (H-vh*scale)/2, vw*scale, vh*scale);
  }
  // Draw overlays
  state.overlays.forEach(ov => {
    if (globalTime < ov.startTime || globalTime >= ov.endTime) return;
    const fs = ov.fontSize || 48;
    ctx2d.font = `${ov.bold?'bold ':''}${fs}px 'Noto Sans JP', sans-serif`;
    ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
    const tw = ctx2d.measureText(ov.text).width, pad = 12;
    const x = W/2;
    const y = ov.posY==='top' ? fs+pad*2 : ov.posY==='center' ? H/2 : H-fs-pad*2;
    ctx2d.fillStyle = hexToRgba(ov.bgColor||'#000000', 0.65);
    ctx2d.beginPath(); ctx2d.roundRect(x-tw/2-pad, y-fs/2-pad/2, tw+pad*2, fs+pad, 8); ctx2d.fill();
    ctx2d.fillStyle = ov.color||'#ffffff'; ctx2d.fillText(ov.text, x, y);
  });
}

// ---------- Export ----------
dom.btnExport.addEventListener('click', startExport);

async function startExport() {
  if (!state.clips.length) return;
  dom.exportModal.style.display = 'flex'; setProgress('FFmpegを読み込んでいます...', 0);
  try {
    await ensureFFmpeg(); setProgress('動画を処理しています...', 5);
    const W=1080, H=1920, trimmed=[];
    for (let i=0; i<state.clips.length; i++) {
      const clip = state.clips[i], inp=`in_${i}.mp4`, out=`tr_${i}.mp4`;
      setProgress(`クリップ ${i+1}/${state.clips.length} を処理中...`, 5+(i/state.clips.length)*55);
      ffmpeg.FS('writeFile', inp, new Uint8Array(await clip.file.arrayBuffer()));
      await ffmpeg.run('-ss',String(clip.trimIn),'-i',inp,'-t',String(clip.trimOut-clip.trimIn),'-vf',`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-y',out);
      ffmpeg.FS('unlink', inp); trimmed.push(out);
    }
    setProgress('クリップを結合中...', 62);
    ffmpeg.FS('writeFile','list.txt', new TextEncoder().encode(trimmed.map(f=>`file '${f}'`).join('\n')));
    await ffmpeg.run('-f','concat','-safe','0','-i','list.txt','-c','copy','-y','merged.mp4');
    trimmed.forEach(f=>{ try{ffmpeg.FS('unlink',f);}catch{} }); ffmpeg.FS('unlink','list.txt');
    let final='merged.mp4';
    if (state.bgm) {
      setProgress('BGMを合成中...', 78);
      const ext=state.bgm.name.split('.').pop().toLowerCase(), bgmFile=`bgm.${ext}`;
      ffmpeg.FS('writeFile', bgmFile, new Uint8Array(await state.bgm.file.arrayBuffer()));
      await ffmpeg.run('-i','merged.mp4','-i',bgmFile,'-filter_complex',`[0:a][1:a]amix=inputs=2:duration=first:weights=1 ${state.bgmVolume.toFixed(2)}`,'-c:v','copy','-y','final.mp4');
      ffmpeg.FS('unlink','merged.mp4'); ffmpeg.FS('unlink',bgmFile); final='final.mp4';
    }
    setProgress('ダウンロード準備中...', 96);
    const out = ffmpeg.FS('readFile', final); ffmpeg.FS('unlink', final);
    const url = URL.createObjectURL(new Blob([out.buffer],{type:'video/mp4'}));
    Object.assign(document.createElement('a'),{href:url,download:'short-video.mp4'}).click();
    setTimeout(()=>URL.revokeObjectURL(url), 10000);
    setProgress('完了！', 100);
    setTimeout(()=>{ dom.exportModal.style.display='none'; }, 1500);
  } catch(err) {
    console.error(err); alert('エクスポートに失敗しました: '+err.message);
    dom.exportModal.style.display='none';
  }
}

function setProgress(text, pct) {
  dom.exportStatusText.textContent = text;
  dom.progressBar.style.width = pct+'%';
  dom.progressLabel.textContent = Math.round(pct)+'%';
}

async function ensureFFmpeg() {
  if (ffmpegLoaded) return;
  dom.ffmpegStatus.textContent = 'FFmpeg: 読込中...'; dom.ffmpegStatus.className = 'status-badge loading';
  await new Promise((ok,ng) => { const s=document.createElement('script'); s.src='https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js'; s.onload=ok; s.onerror=ng; document.head.appendChild(s); });
  ffmpeg = window.FFmpeg.createFFmpeg({ log:false, progress:({ratio})=>{ dom.progressBar.style.width=(5+ratio*85)+'%'; dom.progressLabel.textContent=Math.round(5+ratio*85)+'%'; } });
  await ffmpeg.load();
  ffmpegLoaded = true; dom.ffmpegStatus.textContent = 'FFmpeg: 準備完了'; dom.ffmpegStatus.className = 'status-badge ready';
}

// Preload FFmpeg quietly
window.addEventListener('load', () => setTimeout(()=>ensureFFmpeg().catch(()=>{}), 2000));

// ---------- Init ----------
renderClipList();
updateUI();
if (state.apiKey) {
  addAIMessage('✅ APIキーが設定済みです。動画を追加して要望を入力してください！');
}
