// Content script — injects floating panel into YouTube pages
// Supports multiple licks per video, persistent across sessions
// Auto-loops when opened from Anki link with #lta=start,end hash

(function() {
  const existing = document.getElementById('lta-panel');
  if (existing) existing.remove();
  if (window._ltaListener) chrome.runtime.onMessage.removeListener(window._ltaListener);

  // State
  let startMarker = null;
  let endMarker = null;
  let loopInterval = null;
  let loopPaused = false;
  let licks = []; // Array of { start, end, name }
  let activeLickIndex = -1;
  const FRAME = 1 / 30;

  // Panel HTML
  const panel = document.createElement('div');
  panel.id = 'lta-panel';
  panel.innerHTML = `
    <div class="lta-header" id="ltaDrag">
      <h1>Lick to Anki</h1>
      <button class="lta-close" id="ltaClose">&times;</button>
    </div>
    <div class="lta-status">
      <div class="lta-status-item"><span class="lta-dot pending" id="ltaDotHost"></span><span>yt-dlp</span></div>
      <div class="lta-status-item"><span class="lta-dot pending" id="ltaDotAnki"></span><span>Anki</span></div>
    </div>
    <div class="lta-body">
      <div class="lta-section">Markers</div>
      <div class="lta-markers">
        <div class="lta-marker">
          <div class="lta-marker-label">Start</div>
          <div class="lta-marker-row">
            <button class="lta-nudge" id="ltaSM">&lsaquo;</button>
            <div class="lta-ts empty" id="ltaS">--:--</div>
            <button class="lta-nudge" id="ltaSP">&rsaquo;</button>
          </div>
        </div>
        <div class="lta-marker">
          <div class="lta-marker-label">End</div>
          <div class="lta-marker-row">
            <button class="lta-nudge" id="ltaEM">&lsaquo;</button>
            <div class="lta-ts empty" id="ltaE">--:--</div>
            <button class="lta-nudge" id="ltaEP">&rsaquo;</button>
          </div>
        </div>
      </div>
      <div class="lta-dur" id="ltaDur" style="display:none"><span id="ltaDurV"></span></div>
      <div class="lta-actions">
        <button class="lta-btn" id="ltaMarkS">Mark Start</button>
        <button class="lta-btn" id="ltaMarkE">Mark End</button>
        <button class="lta-btn" id="ltaClear">Clear</button>
      </div>
      <div class="lta-loop" id="ltaLoopRow">
        <label><input type="checkbox" id="ltaLoop"> Loop phrase</label>
      </div>

      <hr class="lta-divider">

      <div class="lta-section">Card</div>
      <input type="text" class="lta-input" id="ltaName" placeholder="card name (auto-generated)">
      <button class="lta-primary" id="ltaCreate" disabled>Create Anki Card</button>

      <hr class="lta-divider">

      <div class="lta-section-row">
        <div class="lta-section">Saved Licks</div>
        <button class="lta-add-btn" id="ltaAddLick" title="Save current markers as a lick" disabled>+</button>
      </div>
      <div id="ltaLicks"></div>

      <div class="lta-msg" id="ltaMsg"></div>
    </div>
    <div class="lta-stamp">&#32654;&#38899;</div>
  `;
  document.body.appendChild(panel);

  // --- Utilities ---
  function fmt(s) {
    if (s == null) return '--:--';
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  }
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 50); }
  const v = () => document.querySelector('video');
  const vId = () => new URLSearchParams(window.location.search).get('v');
  function meta() {
    const ch = document.querySelector('#channel-name a') || document.querySelector('ytd-channel-name a');
    const ti = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') || document.querySelector('h1.title');
    return { channel: ch ? ch.textContent.trim() : 'unknown', title: ti ? ti.textContent.trim() : document.title };
  }
  function genName() {
    const m = meta();
    return `${slug(m.channel)}_${slug(m.title)}_${startMarker != null ? Math.floor(startMarker) : 0}`;
  }

  // --- Storage ---
  function sKey() { const id = vId(); return id ? `lta_${id}` : null; }

  function save() {
    const k = sKey(); if (!k) return;
    chrome.storage.local.set({ [k]: { licks } });
  }

  function load(cb) {
    const k = sKey(); if (!k) return cb();
    chrome.storage.local.get(k, r => {
      if (r[k] && r[k].licks) {
        licks = r[k].licks;
      } else if (r[k] && r[k].s != null) {
        // Migrate old format
        licks = [{ start: r[k].s, end: r[k].e, name: genName() }];
      }
      cb();
    });
  }

  // --- Messages ---
  function msg(text, type) {
    const el = panel.querySelector('#ltaMsg');
    el.textContent = text; el.className = `lta-msg ${type}`;
    if (type === 'success') setTimeout(() => { el.className = 'lta-msg'; }, 4000);
  }

  // --- UI ---
  function updateUI() {
    const sEl = panel.querySelector('#ltaS');
    const eEl = panel.querySelector('#ltaE');
    const nameEl = panel.querySelector('#ltaName');

    sEl.textContent = fmt(startMarker);
    sEl.classList.toggle('empty', startMarker == null);
    eEl.textContent = fmt(endMarker);
    eEl.classList.toggle('empty', endMarker == null);

    panel.querySelector('#ltaSM').disabled = startMarker == null;
    panel.querySelector('#ltaSP').disabled = startMarker == null;
    panel.querySelector('#ltaEM').disabled = endMarker == null;
    panel.querySelector('#ltaEP').disabled = endMarker == null;

    const both = startMarker != null && endMarker != null;
    if (both) {
      panel.querySelector('#ltaDurV').textContent = `${(endMarker - startMarker).toFixed(1)}s`;
      panel.querySelector('#ltaDur').style.display = 'block';
      panel.querySelector('#ltaLoopRow').classList.add('visible');
    } else {
      panel.querySelector('#ltaDur').style.display = 'none';
      panel.querySelector('#ltaLoopRow').classList.remove('visible');
    }
    panel.querySelector('#ltaCreate').disabled = !both;
    panel.querySelector('#ltaAddLick').disabled = !both;
    if (!nameEl.value && startMarker != null) nameEl.value = genName();

    renderLicks();
  }

  function renderLicks() {
    const container = panel.querySelector('#ltaLicks');
    if (licks.length === 0) {
      container.innerHTML = '<div class="lta-empty">Mark start &amp; end, then press + to save</div>';
      return;
    }
    container.innerHTML = licks.map((l, i) => `
      <div class="lta-lick ${i === activeLickIndex ? 'active' : ''}" data-i="${i}">
        <div class="lta-lick-info">
          <div class="lta-lick-name">${l.name}</div>
          <div class="lta-lick-meta">
            <span>${fmt(l.start)} — ${fmt(l.end)}</span>
            <span>${(l.end - l.start).toFixed(1)}s</span>
          </div>
        </div>
        <div class="lta-lick-actions">
          <button class="lta-lick-btn lta-lick-play" data-i="${i}" title="Loop this lick">&#9654;</button>
          <button class="lta-lick-btn lta-lick-del" data-i="${i}" title="Remove">&times;</button>
        </div>
      </div>
    `).join('');

    // Click lick row to load into editor
    container.querySelectorAll('.lta-lick').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.lta-lick-btn')) return;
        const i = parseInt(el.dataset.i);
        loadLick(i);
      });
    });
    // Play button
    container.querySelectorAll('.lta-lick-play').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i);
        loadLick(i);
        panel.querySelector('#ltaLoop').checked = true;
        startLoop();
      });
    });
    // Delete button
    container.querySelectorAll('.lta-lick-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i);
        licks.splice(i, 1);
        if (activeLickIndex === i) { activeLickIndex = -1; startMarker = null; endMarker = null; }
        else if (activeLickIndex > i) activeLickIndex--;
        save(); updateUI();
      });
    });
  }

  function loadLick(i) {
    activeLickIndex = i;
    startMarker = licks[i].start;
    endMarker = licks[i].end;
    panel.querySelector('#ltaName').value = licks[i].name;
    const vo = v(); if (vo) vo.currentTime = startMarker;
    updateUI();
  }

  function saveLick() {
    if (startMarker == null || endMarker == null) return;
    const name = panel.querySelector('#ltaName').value || genName();
    const lick = { start: startMarker, end: endMarker, name };

    if (activeLickIndex >= 0) {
      licks[activeLickIndex] = lick;
    } else {
      licks.push(lick);
      activeLickIndex = licks.length - 1;
    }
    save();
    updateUI();
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

  // --- Health ---
  async function checkHost() {
    const d = panel.querySelector('#ltaDotHost');
    try { await toNative({ action: 'ping' }); d.className = 'lta-dot ok'; return true; }
    catch { d.className = 'lta-dot err'; return false; }
  }
  async function checkAnki() {
    const d = panel.querySelector('#ltaDotAnki');
    try {
      const r = await toAnki({ action: 'version', version: 6 });
      if (r && !r.error) { d.className = 'lta-dot ok'; return true; }
    } catch {}
    d.className = 'lta-dot err'; return false;
  }

  // --- Loop ---
  function startLoop() {
    stopLoop();
    if (startMarker == null || endMarker == null) return;
    const vo = v(); if (!vo) return;
    vo.currentTime = startMarker;
    if (vo.paused) vo.play();
    loopInterval = setInterval(() => {
      if (loopPaused) return;
      const vo = v(); if (!vo) { stopLoop(); return; }
      if (vo.currentTime >= endMarker || vo.currentTime < startMarker - 0.5) {
        vo.currentTime = startMarker;
      }
    }, 150);
  }
  function stopLoop() { if (loopInterval) { clearInterval(loopInterval); loopInterval = null; } }
  function pauseLoop() { loopPaused = true; setTimeout(() => { loopPaused = false; }, 1500); }

  // --- Nudge ---
  function nudge(which, delta) {
    pauseLoop();
    if (which === 's' && startMarker != null) {
      startMarker = Math.max(0, startMarker + delta);
      if (endMarker != null && startMarker >= endMarker) startMarker = endMarker - FRAME;
      const vo = v(); if (vo) vo.currentTime = startMarker;
    }
    if (which === 'e' && endMarker != null) {
      endMarker = Math.max(0, endMarker + delta);
      if (startMarker != null && endMarker <= startMarker) endMarker = startMarker + FRAME;
      const vo = v(); if (vo) vo.currentTime = endMarker;
    }
    // Update saved lick if editing one
    if (activeLickIndex >= 0) {
      licks[activeLickIndex].start = startMarker;
      licks[activeLickIndex].end = endMarker;
    }
    save(); updateUI();
  }

  // --- Create card ---
  async function createCard() {
    const btn = panel.querySelector('#ltaCreate');
    btn.disabled = true;
    btn.textContent = 'Extracting...';

    try {
      const [hostOk, ankiOk] = await Promise.all([checkHost(), checkAnki()]);
      if (!hostOk) throw new Error('yt-dlp host not reachable');
      if (!ankiOk) throw new Error('AnkiConnect not reachable — is Anki open?');

      const name = panel.querySelector('#ltaName').value || genName();
      const id = vId();
      const m = meta();

      // Save lick first
      saveLick();

      const result = await toNative({
        action: 'extract', url: window.location.href,
        start: startMarker, end: endMarker, name
      });

      btn.textContent = 'Creating card...';
      const { filename, data: b64 } = result;
      const startSec = Math.floor(startMarker);
      const ytLink = `https://www.youtube.com/watch?v=${id}&t=${startSec}#lta=${startMarker.toFixed(1)},${endMarker.toFixed(1)}`;

      await toAnki({ action: 'createDeck', version: 6, params: { deck: 'Guitar Phrases' } });
      await toAnki({ action: 'storeMediaFile', version: 6, params: { filename, data: b64 } });

      const dur = (endMarker - startMarker).toFixed(1);

      const front = `<div style="
        font-family: Georgia, 'Noto Serif', serif;
        text-align: center; padding: 30px 20px;
        background: linear-gradient(170deg, #f5e6c8, #e8d5af);
        min-height: 100px;
      ">
        <div style="font-size: 13px; color: #9e8868; letter-spacing: 2px;
          text-transform: uppercase; margin-bottom: 20px;">
          Listen &middot; Learn &middot; Play
        </div>
        [sound:${filename}]
        <div style="margin-top: 20px; display: inline-block;
          background: rgba(139,115,85,0.1); border: 1px solid rgba(139,115,85,0.2);
          border-radius: 4px; padding: 4px 14px;
          font-size: 12px; color: #6b5030;">
          ${dur}s
        </div>
      </div>`;

      const back = `<div style="
        font-family: Georgia, 'Noto Serif', serif;
        text-align: center; padding: 30px 20px;
        background: linear-gradient(170deg, #f5e6c8, #e8d5af);
      ">
        <div style="font-size: 20px; font-weight: 700; color: #3b2f20;
          margin-bottom: 4px; letter-spacing: 0.5px;">
          ${m.channel}
        </div>
        <div style="font-size: 14px; color: #7a6548; margin-bottom: 20px;
          font-style: italic;">
          ${m.title}
        </div>
        <div style="margin-bottom: 20px;">
          <a href="${ytLink}" style="
            color: #c0392b; text-decoration: none; font-size: 13px;
            padding: 6px 16px; border: 1px solid #c0392b; border-radius: 3px;
          ">&#9654;&ensp;Watch at ${fmt(startMarker)}</a>
        </div>
        <div style="
          color: #9e8868; font-size: 13px; font-style: italic;
          padding: 14px; background: rgba(139,115,85,0.08);
          border-radius: 4px; border: 1px solid rgba(139,115,85,0.15);
        ">
          Record yourself, then compare
        </div>
      </div>`;

      const noteResult = await toAnki({
        action: 'addNote', version: 6,
        params: {
          note: {
            deckName: 'Guitar Phrases', modelName: 'Basic',
            fields: { Front: front, Back: back },
            options: { allowDuplicate: false },
            tags: ['guitar', 'phrase', slug(m.channel)]
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
  panel.querySelector('#ltaDrag').addEventListener('mousedown', e => {
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

  panel.querySelector('#ltaMarkS').addEventListener('click', () => {
    const vo = v(); if (!vo) return msg('No video', 'error');
    startMarker = vo.currentTime;
    if (endMarker != null && endMarker <= startMarker) endMarker = null;
    activeLickIndex = -1; // New lick
    panel.querySelector('#ltaName').value = genName();
    updateUI();
  });

  panel.querySelector('#ltaMarkE').addEventListener('click', () => {
    const vo = v(); if (!vo) return msg('No video', 'error');
    if (startMarker != null && vo.currentTime <= startMarker) return msg('End must be after start', 'error');
    endMarker = vo.currentTime;
    updateUI();
  });

  panel.querySelector('#ltaClear').addEventListener('click', () => {
    startMarker = null; endMarker = null; activeLickIndex = -1;
    panel.querySelector('#ltaName').value = '';
    stopLoop(); panel.querySelector('#ltaLoop').checked = false;
    updateUI();
    panel.querySelector('#ltaMsg').className = 'lta-msg';
  });

  panel.querySelector('#ltaS').addEventListener('click', () => {
    if (startMarker == null) return;
    pauseLoop(); const vo = v(); if (vo) vo.currentTime = startMarker;
  });
  panel.querySelector('#ltaE').addEventListener('click', () => {
    if (endMarker == null) return;
    pauseLoop(); const vo = v(); if (vo) vo.currentTime = endMarker;
  });

  panel.querySelector('#ltaSM').addEventListener('click', () => nudge('s', -FRAME));
  panel.querySelector('#ltaSP').addEventListener('click', () => nudge('s', FRAME));
  panel.querySelector('#ltaEM').addEventListener('click', () => nudge('e', -FRAME));
  panel.querySelector('#ltaEP').addEventListener('click', () => nudge('e', FRAME));

  panel.querySelector('#ltaLoop').addEventListener('change', e => {
    e.target.checked ? startLoop() : stopLoop();
  });

  panel.querySelector('#ltaCreate').addEventListener('click', createCard);

  panel.querySelector('#ltaAddLick').addEventListener('click', () => {
    if (startMarker == null || endMarker == null) return;
    saveLick();
    msg('Lick saved', 'success');
  });

  // --- Toggle from extension icon ---
  window._ltaListener = (request, sender, sendResponse) => {
    if (request.action === 'togglePanel') {
      panel.classList.toggle('visible');
      if (panel.classList.contains('visible')) {
        checkHost(); checkAnki();
        load(() => updateUI());
      }
      sendResponse({ ok: true });
    }
    return true;
  };
  chrome.runtime.onMessage.addListener(window._ltaListener);

  // --- Auto-loop from Anki link ---
  function checkHashForAutoLoop() {
    const hash = window.location.hash;
    const match = hash.match(/lta=([\d.]+),([\d.]+)/);
    if (match) {
      startMarker = parseFloat(match[1]);
      endMarker = parseFloat(match[2]);
      panel.classList.add('visible');
      panel.querySelector('#ltaLoop').checked = true;
      // Wait for video to be ready
      const waitForVideo = setInterval(() => {
        const vo = v();
        if (vo && vo.readyState >= 2) {
          clearInterval(waitForVideo);
          checkHost(); checkAnki();
          load(() => {
            updateUI();
            startLoop();
          });
        }
      }, 300);
      // Clean hash so it doesn't re-trigger
      history.replaceState(null, '', window.location.href.replace(/#.*/, ''));
    }
  }
  checkHashForAutoLoop();

  // Block YouTube shortcuts when typing in panel
  panel.addEventListener('keydown', e => e.stopPropagation());
  panel.addEventListener('keyup', e => e.stopPropagation());
  panel.addEventListener('keypress', e => e.stopPropagation());
})();
