/**
 * Facebook Full Post Saver — background.js v55 (v66 build)
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes('facebook.com')) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    console.error('[FB Post Saver] Injection failed:', err);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  // Fetch a URL from the background SW (which sends page cookies via the tab)
  // and return it as a base64 data URI — bypasses CORS restrictions in content scripts.
  if (msg.action === 'fetchAsDataURI') {
    const url = msg.url;
    if (!url || !url.startsWith('http')) { sendResponse({ error: 'bad url' }); return false; }
    (async () => {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) { sendResponse({ error: 'HTTP ' + resp.status + ' ' + resp.statusText }); return; }
        const blob = await resp.blob();
        const ab   = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        const b64 = btoa(binary);
        const mime = blob.type || 'image/jpeg';
        sendResponse({ dataURI: 'data:' + mime + ';base64,' + b64 });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // async
  }

  // Original full-page capture (fallback)
  if (msg.action === 'doCapture') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: 'no tabId' }); return false; }
    chrome.pageCapture.saveAsMHTML({ tabId }, async (mhtmlData) => {
      if (chrome.runtime.lastError || !mhtmlData) {
        sendResponse({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'empty' });
        return;
      }
      try {
        const buf = await mhtmlData.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk)
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        sendResponse({ ok: true, b64: btoa(binary) });
      } catch (e) { sendResponse({ error: e.message }); }
    });
    return true;
  }

  // New: open temp tab with cloned post HTML, capture it, download, close tab
  if (msg.action === 'captureClone') {
    const { html, filename } = msg;

    // Convert HTML string to a data: URL we can open in a tab
    const b64html = btoa(unescape(encodeURIComponent(html)));
    const dataUrl = 'data:text/html;base64,' + b64html;

    chrome.tabs.create({ url: dataUrl, active: false }, (tab) => {
      const tempTabId = tab.id;

      // Wait for tab to finish loading before capturing
      function onUpdated(tabId, changeInfo) {
        if (tabId !== tempTabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);

        // Small extra delay so images in the data: tab can load
        setTimeout(() => {
          chrome.pageCapture.saveAsMHTML({ tabId: tempTabId }, async (mhtmlData) => {
            // Always close temp tab
            chrome.tabs.remove(tempTabId);

            if (chrome.runtime.lastError || !mhtmlData) {
              sendResponse({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'empty capture' });
              return;
            }
            try {
              const buf = await mhtmlData.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let binary = '';
              const chunk = 8192;
              for (let i = 0; i < bytes.length; i += chunk)
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
              const b64 = btoa(binary);

              // Trigger download from background
              const blobUrl = 'data:message/rfc822;base64,' + b64;
              chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ error: e.message });
            }
          });
        }, 1500);
      }

      chrome.tabs.onUpdated.addListener(onUpdated);

      // Safety timeout — close tab and fail if it never loads
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.remove(tempTabId, () => {});
        sendResponse({ error: 'tab load timeout' });
      }, 30000);
    });
    return true; // async
  }
});
