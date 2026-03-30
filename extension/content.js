// Content script — injects floating panel into YouTube pages
// Designed to be re-injected safely (SPA navigations destroy the DOM but not the script context)

(function() {
  // Remove stale panel if it exists (SPA navigation may have destroyed its event handlers)
  const existing = document.getElementById('lta-panel');
  if (existing) existing.remove();

  // Clean up previous listener if re-injected
  if (window._ltaListener) {
    chrome.runtime.onMessage.removeListener(window._ltaListener);
  }

  // State
  let startMarker = null;
  let endMarker = null;
  let loopInterval = null;
  let loopPaused = false;
  const FRAME = 1 / 30;

  // Build panel
  const panel = document.createElement('div');
  panel.id = 'lta-panel';
  panel.innerHTML = `
    <div class="lta-header" id="ltaDragHandle">
      <div class="lta-header-left">
        <h1>Lick to Anki</h1>
      </div>
      <button class="lta-close" id="ltaClose">&times;</button>
    </div>
    <div class="lta-status-bar">
      <div class="lta-status-item">
        <span class="lta-dot pending" id="ltaHostDot"></span><span>yt-dlp</span>
      </div>
      <div class="lta-status-item">
        <span class="lta-dot pending" id="ltaAnkiDot"></span><span>Anki</span>
      </div>
    </div>
    <div class="lta-content">
      <div class="lta-markers">
        <div class="lta-marker-group">
          <div class="lta-marker-label">Start</div>
          <div class="lta-marker-row">
            <button class="lta-nudge" id="ltaStartMinus" title="-1 frame">&lsaquo;</button>
            <div class="lta-marker-value empty" id="ltaStart">--:--</div>
            <button class="lta-nudge" id="ltaStartPlus" title="+1 frame">&rsaquo;</button>
          </div>
        </div>
        <div class="lta-marker-group">
          <div class="lta-marker-label">End</div>
          <div class="lta-marker-row">
            <button class="lta-nudge" id="ltaEndMinus" title="-1 frame">&lsaquo;</button>
            <div class="lta-marker-value empty" id="ltaEnd">--:--</div>
            <button class="lta-nudge" id="ltaEndPlus" title="+1 frame">&rsaquo;</button>
          </div>
        </div>
      </div>
      <div class="lta-duration" id="ltaDuration" style="display:none">
        <span id="ltaDurationVal"></span>
      </div>
      <div class="lta-btn-row">
        <button class="lta-btn" id="ltaBtnStart">Mark Start</button>
        <button class="lta-btn" id="ltaBtnEnd">Mark End</button>
        <button class="lta-btn" id="ltaBtnClear">Clear</button>
      </div>
      <div class="lta-loop-controls" id="ltaLoopControls">
        <label><input type="checkbox" id="ltaLoopCheck"> Loop phrase</label>
      </div>
      <div class="lta-name-label">Card name</div>
      <input type="text" class="lta-name-input" id="ltaCardName" placeholder="auto-generated...">
      <button class="lta-primary" id="ltaBtnCreate" disabled>Create Anki Card</button>
      <div class="lta-message" id="ltaMessage"></div>
    </div>
  `;
  document.body.appendChild(panel);

  // --- Helpers ---
  function fmt(s) {
    if (s == null) return '--:--';
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  }

  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 60);
  }

  const vid = () => document.querySelector('video');
  const vidId = () => new URLSearchParams(window.location.search).get('v');

  function vidMeta() {
    const ch = document.querySelector('#channel-name a') || document.querySelector('ytd-channel-name a');
    const ti = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') || document.querySelector('h1.title');
    return {
      channel: ch ? ch.textContent.trim() : 'unknown',
      title: ti ? ti.textContent.trim() : document.title
    };
  }

  function genName() {
    const m = vidMeta();
    return `${slugify(m.channel)}_${slugify(m.title)}_${startMarker != null ? Math.floor(startMarker) : 0}`;
  }

  function sKey() { const id = vidId(); return id ? `lta_${id}` : null; }

  function saveMarkers() {
    const k = sKey(); if (k) chrome.storage.local.set({ [k]: { s: startMarker, e: endMarker } });
  }

  function loadMarkers(cb) {
    const k = sKey(); if (!k) return cb();
    chrome.storage.local.get(k, r => {
      if (r[k]) { startMarker = r[k].s; endMarker = r[k].e; }
      cb();
    });
  }

  function msg(text, type) {
    const el = panel.querySelector('#ltaMessage');
    el.textContent = text; el.className = `lta-message ${type}`;
    if (type === 'success') setTimeout(() => { el.className = 'lta-message'; }, 4000);
  }

  function updateUI() {
    const sEl = panel.querySelector('#ltaStart');
    const eEl = panel.querySelector('#ltaEnd');
    const nameEl = panel.querySelector('#ltaCardName');

    sEl.textContent = fmt(startMarker);
    sEl.classList.toggle('empty', startMarker == null);
    eEl.textContent = fmt(endMarker);
    eEl.classList.toggle('empty', endMarker == null);

    panel.querySelector('#ltaStartMinus').disabled = startMarker == null;
    panel.querySelector('#ltaStartPlus').disabled = startMarker == null;
    panel.querySelector('#ltaEndMinus').disabled = endMarker == null;
    panel.querySelector('#ltaEndPlus').disabled = endMarker == null;

    const both = startMarker != null && endMarker != null;
    if (both) {
      panel.querySelector('#ltaDurationVal').textContent = `${(endMarker - startMarker).toFixed(1)}s`;
      panel.querySelector('#ltaDuration').style.display = 'block';
      panel.querySelector('#ltaLoopControls').classList.add('visible');
    } else {
      panel.querySelector('#ltaDuration').style.display = 'none';
      panel.querySelector('#ltaLoopControls').classList.remove('visible');
    }
    panel.querySelector('#ltaBtnCreate').disabled = !both;

    if (!nameEl.value && startMarker != null) nameEl.value = genName();
  }

  // --- Background bridge ---
  function toNative(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ target: 'background', action: 'nativeMessage', payload }, r => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (r && r.error) reject(new Error(r.error));
        else resolve(r);
      });
    });
  }

  function toAnki(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ target: 'background', action: 'ankiConnect', payload }, r => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r);
      });
    });
  }

  // --- Health checks ---
  async function checkHost() {
    const d = panel.querySelector('#ltaHostDot');
    try { await toNative({ action: 'ping' }); d.className = 'lta-dot ok'; return true; }
    catch { d.className = 'lta-dot err'; return false; }
  }

  async function checkAnki() {
    const d = panel.querySelector('#ltaAnkiDot');
    try {
      const r = await toAnki({ action: 'version', version: 6 });
      if (r && !r.error) { d.className = 'lta-dot ok'; return true; }
    } catch {}
    d.className = 'lta-dot err';
    return false;
  }

  // --- Loop ---
  function startLoop() {
    stopLoop();
    if (startMarker == null || endMarker == null) return;
    const v = vid(); if (!v) return;
    v.currentTime = startMarker;
    loopInterval = setInterval(() => {
      if (loopPaused) return;
      const v = vid(); if (!v) { stopLoop(); return; }
      if (v.currentTime >= endMarker || v.currentTime < startMarker - 0.5) {
        v.currentTime = startMarker;
      }
    }, 200);
  }

  function stopLoop() {
    if (loopInterval) { clearInterval(loopInterval); loopInterval = null; }
  }

  function pauseLoop() {
    loopPaused = true;
    setTimeout(() => { loopPaused = false; }, 1500);
  }

  // --- Nudge ---
  function nudge(which, delta) {
    pauseLoop();
    if (which === 'start' && startMarker != null) {
      startMarker = Math.max(0, startMarker + delta);
      if (endMarker != null && startMarker >= endMarker) startMarker = endMarker - FRAME;
      const v = vid(); if (v) v.currentTime = startMarker;
    }
    if (which === 'end' && endMarker != null) {
      endMarker = Math.max(0, endMarker + delta);
      if (startMarker != null && endMarker <= startMarker) endMarker = startMarker + FRAME;
      const v = vid(); if (v) v.currentTime = endMarker;
    }
    saveMarkers();
    updateUI();
  }

  // --- Create card ---
  async function createCard() {
    const btn = panel.querySelector('#ltaBtnCreate');
    btn.disabled = true;
    btn.textContent = 'Extracting...';

    try {
      const [hostOk, ankiOk] = await Promise.all([checkHost(), checkAnki()]);
      if (!hostOk) throw new Error('yt-dlp host not reachable');
      if (!ankiOk) throw new Error('AnkiConnect not reachable — is Anki open?');

      const name = panel.querySelector('#ltaCardName').value || genName();
      const id = vidId();

      const result = await toNative({
        action: 'extract', url: window.location.href,
        start: startMarker, end: endMarker, name
      });

      btn.textContent = 'Creating card...';
      const { filename, data: b64 } = result;
      const ytLink = `https://youtu.be/${id}?t=${Math.floor(startMarker)}`;

      await toAnki({ action: 'createDeck', version: 6, params: { deck: 'Guitar Phrases' } });
      await toAnki({ action: 'storeMediaFile', version: 6, params: { filename, data: b64 } });

      const noteResult = await toAnki({
        action: 'addNote', version: 6,
        params: {
          note: {
            deckName: 'Guitar Phrases', modelName: 'Basic',
            fields: {
              Front: `[sound:${filename}]`,
              Back: `<a href="${ytLink}">${ytLink}</a><br><br><i>[record yourself, then compare]</i>`
            },
            options: { allowDuplicate: false },
            tags: ['guitar', 'phrase']
          }
        }
      });
      if (noteResult.error) throw new Error(`Anki: ${noteResult.error}`);
      msg(`Card created: ${name}`, 'success');
    } catch (e) {
      msg(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Anki Card';
      updateUI();
    }
  }

  // --- Drag ---
  let dragging = false, ox, oy;
  panel.querySelector('#ltaDragHandle').addEventListener('mousedown', e => {
    if (e.target.closest('.lta-close')) return;
    dragging = true;
    ox = e.clientX - panel.offsetLeft;
    oy = e.clientY - panel.offsetTop;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.left = (e.clientX - ox) + 'px';
    panel.style.top = (e.clientY - oy) + 'px';
    panel.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // --- Event handlers ---
  panel.querySelector('#ltaClose').addEventListener('click', () => panel.classList.remove('visible'));

  panel.querySelector('#ltaBtnStart').addEventListener('click', () => {
    const v = vid(); if (!v) return msg('No video', 'error');
    startMarker = v.currentTime;
    if (endMarker != null && endMarker <= startMarker) endMarker = null;
    saveMarkers();
    panel.querySelector('#ltaCardName').value = genName();
    updateUI();
  });

  panel.querySelector('#ltaBtnEnd').addEventListener('click', () => {
    const v = vid(); if (!v) return msg('No video', 'error');
    if (startMarker != null && v.currentTime <= startMarker) return msg('End must be after start', 'error');
    endMarker = v.currentTime;
    saveMarkers();
    updateUI();
  });

  panel.querySelector('#ltaBtnClear').addEventListener('click', () => {
    startMarker = null; endMarker = null;
    panel.querySelector('#ltaCardName').value = '';
    stopLoop();
    panel.querySelector('#ltaLoopCheck').checked = false;
    saveMarkers(); updateUI();
    panel.querySelector('#ltaMessage').className = 'lta-message';
  });

  panel.querySelector('#ltaStart').addEventListener('click', () => {
    if (startMarker == null) return;
    pauseLoop();
    const v = vid(); if (v) v.currentTime = startMarker;
  });

  panel.querySelector('#ltaEnd').addEventListener('click', () => {
    if (endMarker == null) return;
    pauseLoop();
    const v = vid(); if (v) v.currentTime = endMarker;
  });

  panel.querySelector('#ltaStartMinus').addEventListener('click', () => nudge('start', -FRAME));
  panel.querySelector('#ltaStartPlus').addEventListener('click', () => nudge('start', FRAME));
  panel.querySelector('#ltaEndMinus').addEventListener('click', () => nudge('end', -FRAME));
  panel.querySelector('#ltaEndPlus').addEventListener('click', () => nudge('end', FRAME));

  panel.querySelector('#ltaLoopCheck').addEventListener('change', e => {
    e.target.checked ? startLoop() : stopLoop();
  });

  panel.querySelector('#ltaBtnCreate').addEventListener('click', createCard);

  // --- Toggle from extension icon ---
  window._ltaListener = (request, sender, sendResponse) => {
    if (request.action === 'togglePanel') {
      panel.classList.toggle('visible');
      if (panel.classList.contains('visible')) {
        checkHost(); checkAnki();
        loadMarkers(() => updateUI());
      }
      sendResponse({ ok: true });
    }
    return true;
  };
  chrome.runtime.onMessage.addListener(window._ltaListener);

  // Block YouTube keyboard shortcuts when panel is focused
  panel.addEventListener('keydown', e => e.stopPropagation());
  panel.addEventListener('keyup', e => e.stopPropagation());
  panel.addEventListener('keypress', e => e.stopPropagation());
})();
