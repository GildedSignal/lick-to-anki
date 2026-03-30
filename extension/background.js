// Background service worker

const HOST_NAME = 'com.julien.licktoanki';

// Extension icon click → inject + toggle panel
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes('youtube.com')) return;

  // Always inject — content.js is idempotent (checks for existing panel)
  // Use world: 'ISOLATED' (default) so it runs fresh even after SPA navigation
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (e) {
    console.error('[lick-to-anki] Injection failed:', e.message);
    return;
  }

  // Retry toggle a few times — script may need a moment to register listener
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 50));
    const ok = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, resp => {
        resolve(!chrome.runtime.lastError);
      });
    });
    if (ok) break;
  }
});

// Bridge: native messaging + AnkiConnect (content scripts can't reach localhost)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target !== 'background') return;

  if (request.action === 'nativeMessage') {
    chrome.runtime.sendNativeMessage(HOST_NAME, request.payload, response => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error('[lick-to-anki] Native messaging error:', err.message);
        sendResponse({ error: err.message });
      } else {
        sendResponse(response);
      }
    });
  }

  if (request.action === 'ankiConnect') {
    fetch('http://localhost:8765', {
      method: 'POST',
      body: JSON.stringify(request.payload),
      signal: AbortSignal.timeout(5000)
    })
    .then(r => r.json())
    .then(data => sendResponse(data))
    .catch(e => sendResponse({ error: e.message }));
  }

  return true;
});
