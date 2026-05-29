// AI ショート動画エディタ - app.js

const state = {
  clips: [], overlays: [], bgm: null, bgmVolume: 0.5,
  apiKey: localStorage.getItem('gemini_api_key') || '',
  isPlaying: false, playbackOffset: 0, playStartWallTime: 0,
  audioCtx: null, bgmSource: null, bgmGain: null,
};
const CLIP_COLORS = ['#7c5cfc','#5c9cfc','#5ccc8c','#fcb05c','#fc6c5c','#c05cfc','#5cccfc','#fc5c9c'];
let clipColorIndex=0, ffmpeg=null, ffmpegLoaded=false, rafId=null, lastClipId=null, frameCount=0;

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

const genId = () => Math.random().toString(36).slice(2, 9);
const fmt = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
const totalDur = () => state.clips.reduce((a,c) => a+(c.trimOut-c.trimIn), 0);
function clipAt(t) {
  let e=0;
  for (const c of state.clips) { const d=c.trimOut-c.trimIn; if (t<e+d) return {clip:c,localTime:c.trimIn+(t-e)}; e+=d; }
  return null;
}
function hexRgba(hex,a) { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; }

const videoEls={};
function getVid(id) { if (!videoEls[id]) { const v=document.createElement('video'); v.preload='auto'; v.style.display='none'; v.playsInline=true; document.body.appendChild(v); videoEls[id]=v; } return videoEls[id]; }
function releaseVid(id) { if (videoEls[id]) { videoEls[id].src=''; videoEls[id].remove(); delete videoEls[id]; } }

function genThumb(clip) {
  return new Promise(resolve => {
    const v=dom.thumbVideo; v.src=clip.objectURL; v.currentTime=1.0;
    v.addEventListener('seeked', () => { const c=document.createElement('canvas'); c.width=96; c.height=54; c.getContext('2d').drawImage(v,0,0,96,54); v.src=''; resolve(c.toDataURL('image/jpeg',0.6)); }, {once:true});
    v.addEventListener('error', () => { v.src=''; resolve(''); }, {once:true});
  });
}

// Upload
dom.dropZone.addEventListener('click', () => dom.fileInput.click());
dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('dragover'); });
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('dragover'));
dom.dropZone.addEventListener('drop', e => { e.preventDefault(); dom.dropZone.classList.remove('dragover'); addVideos([...e.dataTransfer.files].filter(f=>f.type.startsWith('video/'))); });
dom.fileInput.addEventListener('change', () => { addVideos([...dom.fileInput.files]); dom.fileInput.value=''; });

async function addVideos(files) {
  for (const file of files) {
    if (file.size > 300*1024*1024) { aiMsg('⚠️ '+file.name+' は300MBを超えています。'); continue; }
    const url=URL.createObjectURL(file);
    const dur=await new Promise(r => { const v=document.createElement('video'); v.preload='metadata'; v.src=url; v.onloadedmetadata=()=>r(v.duration||0); v.onerror=()=>r(0); });
    const clip={id:genId(),name:file.name.replace(/\.[^.]+$/,''),file,objectURL:url,duration:dur,trimIn:0,trimOut:dur,color:CLIP_COLORS[clipColorIndex++%CLIP_COLORS.length],thumb:''};
    getVid(clip.id).src=url; state.clips.push(clip);
    clip.thumb=await genThumb(clip);
    renderClips(); renderState(); updateUI();
  }
}

// BGM
dom.bgmZone.addEventListener('click', () => dom.bgmInput.click());
dom.bgmInput.addEventListener('change', () => { if (dom.bgmInput.files[0]) loadBGM(dom.bgmInput.files[0]); dom.bgmInput.value=''; });
dom.btnRemoveBgm.addEventListener('click', () => { state.bgm=null; dom.bgmInfo.style.display='none'; dom.bgmZone.style.display='block'; stopBGM(); renderState(); });

async function loadBGM(file) {
  ensureAudio();
  try {
    const ab=await state.audioCtx.decodeAudioData(await file.arrayBuffer());
    state.bgm={file,name:file.name,audioBuffer:ab};
    dom.bgmNameText.textContent=file.name.replace(/\.[^.]+$/,'');
    dom.bgmInfo.style.display='flex'; dom.bgmZone.style.display='none'; renderState();
  } catch { aiMsg('⚠️ 音楽ファイルの読み込みに失敗しました（MP3/AAC/WAV対応）'); }
}
function ensureAudio() { if (!state.audioCtx) { state.audioCtx=new (window.AudioContext||window.webkitAudioContext)(); state.bgmGain=state.audioCtx.createGain(); state.bgmGain.gain.value=state.bgmVolume; state.bgmGain.connect(state.audioCtx.destination); } }
function playBGM(offset) { if (!state.bgm||!state.audioCtx) return; stopBGM(); const s=state.audioCtx.createBufferSource(); s.buffer=state.bgm.audioBuffer; s.loop=true; s.connect(state.bgmGain); s.start(0,offset%state.bgm.audioBuffer.duration); state.bgmSource=s; }
function stopBGM() { if (state.bgmSource) { try{state.bgmSource.stop();}catch{} state.bgmSource=null; } }

// Render
function renderClips() {
  dom.clipList.innerHTML='';
  state.clips.forEach((clip,i) => {
    const item=document.createElement('div'); item.className='clip-item';
    item.innerHTML=`<div class="clip-num" style="background:${clip.color}">${i+1}</div><img class="clip-thumb" src="${clip.thumb||''}" alt=""><div class="clip-info"><div class="clip-name" title="${clip.name}">${clip.name}</div><div class="clip-meta">${(clip.trimOut-clip.trimIn).toFixed(1)}秒使用</div></div><button class="btn-icon" data-del="${clip.id}">✕</button>`;
    item.querySelector('[data-del]').addEventListener('click', e => { e.stopPropagation(); URL.revokeObjectURL(clip.objectURL); releaseVid(clip.id); state.clips=state.clips.filter(c=>c.id!==clip.id); renderClips(); renderState(); updateUI(); });
    dom.clipList.appendChild(item);
  });
  dom.placeholder.style.display=state.clips.length?'none':'flex';
}

function renderState() {
  const has=state.overlays.length>0||state.bgm||state.clips.some(c=>c.trimIn>0||c.trimOut<c.duration-0.05);
  dom.editStatePanel.style.display=(state.clips.length&&has)?'block':'none';
  dom.editStateList.innerHTML='';
  state.clips.forEach((c,i) => { if (c.trimIn>0||c.trimOut<c.duration-0.05) { const el=document.createElement('div'); el.className='state-item'; el.innerHTML=`<strong>クリップ${i+1}</strong>: ${c.trimIn.toFixed(1)}s〜${c.trimOut.toFixed(1)}s`; dom.editStateList.appendChild(el); } });
  if (state.bgm) { const el=document.createElement('div'); el.className='state-item'; el.innerHTML=`<strong>BGM</strong>: ${state.bgm.name.replace(/\.[^.]+$/,'')} (音量${Math.round(state.bgmVolume*100)}%)`; dom.editStateList.appendChild(el); }
  state.overlays.forEach(o => { const el=document.createElement('div'); el.className='state-item'; el.innerHTML=`<strong>テキスト</strong>: 「${o.text}」 ${o.startTime.toFixed(1)}s〜${o.endTime.toFixed(1)}s`; dom.editStateList.appendChild(el); });
}

function updateUI() {
  dom.btnExport.disabled=state.clips.length===0;
  const ok=state.clips.length>0&&!!state.apiKey;
  dom.btnSend.disabled=!ok;
  dom.chatInput.placeholder=ok?'編集の要望を入力... (Enter で送信、Shift+Enter で改行)':state.clips.length===0?'先に動画を追加してください':'先に ⚙ APIキーを設定してください';
}

// API Key modal
dom.btnApiKey.addEventListener('click', () => { dom.apiKeyInput.value=state.apiKey; dom.apiModal.style.display='flex'; setTimeout(()=>dom.apiKeyInput.focus(),50); });
dom.btnSaveKey.addEventListener('click', () => { const k=dom.apiKeyInput.value.trim(); state.apiKey=k; localStorage.setItem('gemini_api_key',k); dom.apiModal.style.display='none'; updateUI(); if(k) aiMsg('✅ APIキーを保存しました。要望を入力してください！'); });
dom.btnCancelKey.addEventListener('click', () => dom.apiModal.style.display='none');
dom.apiModal.addEventListener('click', e => { if(e.target===dom.apiModal) dom.apiModal.style.display='none'; });
dom.apiKeyInput.addEventListener('keydown', e => { if(e.key==='Enter') dom.btnSaveKey.click(); });

// Chat
dom.chatInput.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
dom.btnSend.addEventListener('click', send);

function userMsg(text) { const d=document.createElement('div'); d.className='msg msg-user'; d.innerHTML=`<div class="msg-bubble">${text.replace(/\n/g,'<br>')}</div>`; dom.chatMessages.appendChild(d); scroll(); }
function aiMsg(text) { const d=document.createElement('div'); d.className='msg msg-ai'; d.innerHTML=`<div class="msg-bubble">${text.replace(/\n/g,'<br>')}</div>`; dom.chatMessages.appendChild(d); scroll(); return d; }
function thinking() { const d=document.createElement('div'); d.className='msg msg-ai msg-thinking'; d.innerHTML=`<div class="msg-bubble">🤖 考えています<span class="thinking-dots"></span></div>`; dom.chatMessages.appendChild(d); scroll(); return d; }
function scroll() { dom.chatMessages.scrollTop=dom.chatMessages.scrollHeight; }

async function send() {
  const text=dom.chatInput.value.trim();
  if (!text||dom.btnSend.disabled) return;
  dom.chatInput.value=''; userMsg(text); dom.btnSend.disabled=true;
  const t=thinking();
  try {
    const plan=await callGemini(text); t.remove();
    applyPlan(plan);
    aiMsg((plan.message||'編集を適用しました！')+'\n\nプレビューを確認して、よければ「MP4 ダウンロード」で書き出してください。\nさらに調整したい場合はお気軽にどうぞ！');
  } catch(err) {
    t.remove();
    let m='⚠️ エラーが発生しました。';
    if (err.message.includes('401')||err.message.includes('API_KEY')) m+='\nAPIキーが正しくない可能性があります。⚙ ボタンで確認してください。';
    else if (err.message.includes('429')) m+='\nAPIの利用制限に達しました。少し待ってから再試行してください。';
    else m+='\n詳細: '+err.message;
    aiMsg(m);
  }
  updateUI();
}

async function callGemini(msg) {
  if (!state.apiKey) throw new Error('APIキー未設定');
  const clips=state.clips.map((c,i)=>`- クリップ${i+1}: 「${c.name}」(元:${c.duration.toFixed(1)}秒, 現在:${c.trimIn.toFixed(1)}s〜${c.trimOut.toFixed(1)}s)`).join('\n');
  const ovs=state.overlays.length?'\n現在のテキスト:\n'+state.overlays.map(o=>`- 「${o.text}」 ${o.startTime.toFixed(1)}s〜${o.endTime.toFixed(1)}s (${o.posY})`).join('\n'):'';
  const bgm=state.bgm?`\nBGM: 「${state.bgm.name}」(音量${Math.round(state.bgmVolume*100)}%)`:'\nBGM: なし';
  const prompt=`あなたはショート動画（TikTok・Reels・Shorts用、縦型9:16）の編集AIです。
ユーザーの要望を解釈してJSON編集指示を返してください。

【素材】
${clips}${bgm}${ovs}
合計時間: ${totalDur().toFixed(1)}秒

【JSONスキーマ】
{
  "clips": [{"index":0始まりの番号,"trimIn":開始秒,"trimOut":終了秒}],
  "clipOrder": [インデックス配列],
  "overlays": [{"text":"テキスト","startTime":秒,"endTime":秒,"posY":"top|center|bottom","fontSize":48,"color":"#ffffff","bgColor":"#000000","bold":false}],
  "bgmVolume": 0〜1,
  "message": "日本語で何をしたか説明"
}
変更しないフィールドは省略OK。overlaysは全置き換え。trimOutはduration以下に。messageは必須。

ユーザーの要望: ${msg}`;

  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${state.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.3}})});
  if (!r.ok) throw new Error(r.status+' '+(await r.text()).slice(0,200));
  const data=await r.json();
  const raw=data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('応答なし');
  return JSON.parse(raw);
}

function applyPlan(plan) {
  if (plan.clipOrder?.length===state.clips.length) state.clips=plan.clipOrder.map(i=>state.clips[i]).filter(Boolean);
  plan.clips?.forEach(c=>{ const cl=state.clips[c.index]; if(!cl) return; if(c.trimIn!=null) cl.trimIn=Math.max(0,Math.min(c.trimIn,cl.duration)); if(c.trimOut!=null) cl.trimOut=Math.max(cl.trimIn+0.1,Math.min(c.trimOut,cl.duration)); });
  if (plan.overlays!=null) state.overlays=(plan.overlays||[]).map(o=>({id:genId(),text:o.text||'',startTime:o.startTime||0,endTime:o.endTime||3,posY:o.posY||'bottom',fontSize:o.fontSize||48,color:o.color||'#ffffff',bgColor:o.bgColor||'#000000',bold:o.bold||false}));
  if (plan.bgmVolume!=null) { state.bgmVolume=Math.max(0,Math.min(1,plan.bgmVolume)); if(state.bgmGain) state.bgmGain.gain.value=state.bgmVolume; }
  seekTo(0); renderClips(); renderState(); updateUI();
}

// Playback
dom.btnPlay.addEventListener('click', () => { if(!state.clips.length) return; ensureAudio(); state.audioCtx.resume(); state.isPlaying?pause():play(); });
dom.btnRewind.addEventListener('click', () => seekTo(0));

function play() {
  if (!state.clips.length) return;
  if (state.playbackOffset>=totalDur()) state.playbackOffset=0;
  state.isPlaying=true; state.playStartWallTime=performance.now(); dom.btnPlay.textContent='⏸';
  const r=clipAt(state.playbackOffset); if(r){const v=getVid(r.clip.id);v.currentTime=r.localTime;v.play().catch(()=>{});lastClipId=r.clip.id;}
  if(state.bgm) playBGM(state.playbackOffset);
  rafId=requestAnimationFrame(loop);
}
function pause() { state.isPlaying=false; state.playbackOffset+=(performance.now()-state.playStartWallTime)/1000; dom.btnPlay.textContent='▶'; if(rafId){cancelAnimationFrame(rafId);rafId=null;} stopBGM(); }
function seekTo(t) {
  const was=state.isPlaying; if(was) pause();
  state.playbackOffset=t;
  const r=clipAt(t);
  if(r){const v=getVid(r.clip.id);v.src=r.clip.objectURL;v.currentTime=r.localTime;v.addEventListener('seeked',()=>draw(t,r.clip,v),{once:true});}
  else ctx2d.clearRect(0,0,dom.canvas.width,dom.canvas.height);
  dom.timecode.textContent=`${fmt(t)} / ${fmt(totalDur())}`;
  if(was) play();
}

function loop() {
  if (!state.isPlaying) return;
  const gt=state.playbackOffset+(performance.now()-state.playStartWallTime)/1000, tot=totalDur();
  if (gt>=tot) { state.playbackOffset=tot;state.isPlaying=false;dom.btnPlay.textContent='▶';stopBGM();dom.timecode.textContent=`${fmt(tot)} / ${fmt(tot)}`; return; }
  const r=clipAt(gt);
  if (r) {
    const v=getVid(r.clip.id);
    if (r.clip.id!==lastClipId) { if(lastClipId)getVid(lastClipId).pause(); v.src=r.clip.objectURL;v.currentTime=r.localTime;v.play().catch(()=>{});lastClipId=r.clip.id; }
    if (++frameCount%60===0&&Math.abs(v.currentTime-r.localTime)>0.3) v.currentTime=r.localTime;
    draw(gt,r.clip,v);
  }
  dom.timecode.textContent=`${fmt(gt)} / ${fmt(tot)}`;
  rafId=requestAnimationFrame(loop);
}

function draw(gt, clip, vid) {
  const W=dom.canvas.width,H=dom.canvas.height;
  ctx2d.fillStyle='#000'; ctx2d.fillRect(0,0,W,H);
  if (vid.readyState>=2) { const vw=vid.videoWidth||1,vh=vid.videoHeight||1,sc=Math.min(W/vw,H/vh); ctx2d.drawImage(vid,(W-vw*sc)/2,(H-vh*sc)/2,vw*sc,vh*sc); }
  state.overlays.forEach(o => {
    if (gt<o.startTime||gt>=o.endTime) return;
    const fs=o.fontSize||48; ctx2d.font=`${o.bold?'bold ':''}${fs}px 'Noto Sans JP',sans-serif`; ctx2d.textAlign='center'; ctx2d.textBaseline='middle';
    const tw=ctx2d.measureText(o.text).width,pad=12,x=W/2;
    const y=o.posY==='top'?fs+pad*2:o.posY==='center'?H/2:H-fs-pad*2;
    ctx2d.fillStyle=hexRgba(o.bgColor||'#000000',0.65); ctx2d.beginPath(); ctx2d.roundRect(x-tw/2-pad,y-fs/2-pad/2,tw+pad*2,fs+pad,8); ctx2d.fill();
    ctx2d.fillStyle=o.color||'#ffffff'; ctx2d.fillText(o.text,x,y);
  });
}

// Export
dom.btnExport.addEventListener('click', async () => {
  if (!state.clips.length) return;
  dom.exportModal.style.display='flex'; setProg('FFmpegを読み込んでいます...',0);
  try {
    await ensureFFmpeg(); setProg('動画を処理しています...',5);
    const W=1080,H=1920,tr=[];
    for (let i=0;i<state.clips.length;i++) {
      const c=state.clips[i],inp=`in_${i}.mp4`,out=`tr_${i}.mp4`;
      setProg(`クリップ ${i+1}/${state.clips.length} 処理中...`,5+(i/state.clips.length)*55);
      ffmpeg.FS('writeFile',inp,new Uint8Array(await c.file.arrayBuffer()));
      await ffmpeg.run('-ss',String(c.trimIn),'-i',inp,'-t',String(c.trimOut-c.trimIn),'-vf',`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-y',out);
      ffmpeg.FS('unlink',inp); tr.push(out);
    }
    setProg('結合中...',62);
    ffmpeg.FS('writeFile','list.txt',new TextEncoder().encode(tr.map(f=>`file '${f}'`).join('\n')));
    await ffmpeg.run('-f','concat','-safe','0','-i','list.txt','-c','copy','-y','merged.mp4');
    tr.forEach(f=>{try{ffmpeg.FS('unlink',f);}catch{}}); ffmpeg.FS('unlink','list.txt');
    let fin='merged.mp4';
    if (state.bgm) {
      setProg('BGM合成中...',78);
      const ext=state.bgm.name.split('.').pop().toLowerCase(),bf=`bgm.${ext}`;
      ffmpeg.FS('writeFile',bf,new Uint8Array(await state.bgm.file.arrayBuffer()));
      await ffmpeg.run('-i','merged.mp4','-i',bf,'-filter_complex',`[0:a][1:a]amix=inputs=2:duration=first:weights=1 ${state.bgmVolume.toFixed(2)}`,'-c:v','copy','-y','final.mp4');
      ffmpeg.FS('unlink','merged.mp4'); ffmpeg.FS('unlink',bf); fin='final.mp4';
    }
    setProg('ダウンロード準備中...',96);
    const out=ffmpeg.FS('readFile',fin); ffmpeg.FS('unlink',fin);
    const url=URL.createObjectURL(new Blob([out.buffer],{type:'video/mp4'}));
    Object.assign(document.createElement('a'),{href:url,download:'short-video.mp4'}).click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    setProg('完了！',100); setTimeout(()=>{dom.exportModal.style.display='none';},1500);
  } catch(err) { console.error(err); alert('エクスポート失敗: '+err.message); dom.exportModal.style.display='none'; }
});

function setProg(t,p) { dom.exportStatusText.textContent=t; dom.progressBar.style.width=p+'%'; dom.progressLabel.textContent=Math.round(p)+'%'; }

async function ensureFFmpeg() {
  if (ffmpegLoaded) return;
  dom.ffmpegStatus.textContent='FFmpeg: 読込中...'; dom.ffmpegStatus.className='status-badge loading';
  await new Promise((ok,ng)=>{const s=document.createElement('script');s.src='https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';s.onload=ok;s.onerror=ng;document.head.appendChild(s);});
  ffmpeg=window.FFmpeg.createFFmpeg({log:false,progress:({ratio})=>{dom.progressBar.style.width=(5+ratio*85)+'%';dom.progressLabel.textContent=Math.round(5+ratio*85)+'%';}});
  await ffmpeg.load();
  ffmpegLoaded=true; dom.ffmpegStatus.textContent='FFmpeg: 準備完了'; dom.ffmpegStatus.className='status-badge ready';
}
window.addEventListener('load',()=>setTimeout(()=>ensureFFmpeg().catch(()=>{}),2000));

renderClips(); updateUI();
if (state.apiKey) aiMsg('✅ APIキーが設定済みです。動画を追加して要望を入力してください！');