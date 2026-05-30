/**
 * Content Script for Gemini for Gmail.
 * Injected into mail.google.com.
 *
 * Responsibilities:
 * 1. Observe Gmail's DOM for compose/reply windows appearing (SPA)
 * 2. Inject an inline UI bar above the compose toolbar
 * 3. Read email thread content when user clicks "Generate"
 * 4. Send prompt + page content to background script
 * 5. Write Gemini's response into the compose contenteditable div
 * 6. Handle errors gracefully with user-visible messages
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const COMPOSE_CONTAINER_SELECTORS = [
  'div[role="dialog"][aria-label*="New Message"]',
  'div[role="dialog"][aria-label*="Reply"]',
  'div[role="dialog"][aria-label*="Forward"]',
  'div[role="dialog"][aria-label*="Message"]',
  'div.ae4.UI',                       // Common compose container class
  'div.aDg',                          // Another compose container variant
];

const COMPOSE_TOOLBAR_SELECTOR = '.btC';  // Gmail's compose toolbar container
const COMPOSE_TEXTAREA_SELECTORS = [
  // Most stable: Gmail-specific g_editable attribute + ARIA role
  'div[role="textbox"][aria-label][g_editable="true"]',
  // Gmail-specific g_editable + contenteditable
  'div[contenteditable="true"][g_editable="true"]',
  // ARIA role + contenteditable (original selectors as fallback)
  'div[contenteditable="true"][role="textbox"]',
  'div[role="textbox"][aria-label^="Message Body"]',
  'div[role="textbox"][aria-label*="Body"]',
  'div[role="textbox"][aria-label*="Message"]',
  // Class-based last resort (note: aiL not Al)
  '.Am.aiL.editable',
];

// The reading pane selectors (for getting email thread context)
const EMAIL_BODY_SELECTORS = [
  '.a3s.aiL',                           // Email body in reading pane
  '.h7',                                // Alternative reading pane
  '[role="main"] .a3s',                 // Modern Gmail
  'div[role="main"] div[aria-label="Message Body"]',
  // Fallback: any visible email content area
  '.gs .a3s',
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let composeObserver = null;
const processedComposeWindows = new WeakMap();  // Auto-GC tracking
let debounceTimer = null;
const generatingWindows = new WeakMap();  // Prevents duplicate concurrent generations
const activeAbortControllers = new Set();  // Track AbortControllers for cleanup

// ---------------------------------------------------------------------------
// Initialization: Start observing Gmail's DOM for compose windows
// ---------------------------------------------------------------------------
function init() {
  console.log('[Gemini for Gmail] Content script initialized.');

  // Run a scan immediately (in case compose is already open)
  scanForComposeWindows();

  // Set up MutationObserver on document.body
  // IMPORTANT: Only childList + subtree. NEVER add attributes: true -- causes infinite loops on Gmail!
  composeObserver = new MutationObserver(() => {
    // Debounce: batch rapid DOM changes into a single scan
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanForComposeWindows();
    }, 50);
  });

  composeObserver.observe(document.body, {
    childList: true,
    subtree: true,
    // DO NOT add attributes: true
  });
}

// ---------------------------------------------------------------------------
// Scan for compose windows in the DOM
// ---------------------------------------------------------------------------
function scanForComposeWindows() {
  for (const selector of COMPOSE_CONTAINER_SELECTORS) {
    const containers = document.querySelectorAll(selector);
    for (const container of containers) {
      // Skip already-processed compose windows
      if (!processedComposeWindows.has(container)) {
        processedComposeWindows.set(container, true);
        console.log('[Gemini for Gmail] New compose window detected:', selector);
        injectGeminiBar(container);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inject the Gemini inline bar into a compose window
// ---------------------------------------------------------------------------
function injectGeminiBar(composeContainer, retries = 0) {
  // Per-instance IME composition state (isolated per compose window)
  let isComposing = false;

  // Check if we already injected into this specific container
  if (composeContainer.querySelector('.gemini-gmail-bar-root')) {
    return;
  }

  // Find the toolbar to inject ABOVE it (so our bar is between the editor and toolbar)
  const toolbar = composeContainer.querySelector(COMPOSE_TOOLBAR_SELECTOR);
  if (!toolbar) {
    const MAX_RETRIES = 15;
    if (retries < MAX_RETRIES) {
      setTimeout(() => injectGeminiBar(composeContainer, retries + 1), 200);
    } else {
      console.warn('[Gemini for Gmail] Toolbar not found after max retries, giving up.');
    }
    return;
  }

  // Verify toolbar has a parent before creating host or proceeding
  if (!toolbar.parentNode) { console.warn('[Gemini for Gmail] toolbar.parentNode is null, aborting injection.'); return; }

  // Create host element for Shadow DOM
  const host = document.createElement('div');
  host.className = 'gemini-gmail-bar-root';

  // Create an AbortController for cleanup when compose window is destroyed
  const ac = new AbortController();
  activeAbortControllers.add(ac);

  toolbar.parentNode.insertBefore(host, toolbar);

  // Auto-abort listeners when the compose window is destroyed (host removed from DOM)
  const removalObserver = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      removalObserver.disconnect();
      ac.abort();
      activeAbortControllers.delete(ac);
      // Clean up WeakMap entries so the same element can be re-injected if reused
      processedComposeWindows.delete(composeContainer);
      generatingWindows.delete(composeContainer);
    }
  });
  removalObserver.observe(document.body, { childList: true, subtree: true });

  // Attach closed Shadow DOM for complete style isolation
  const shadow = host.attachShadow({ mode: 'closed' });

  // Inject our CSS into the shadow root
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(getGeminiBarStyles());
  shadow.adoptedStyleSheets = [sheet];

  // Build the UI inside the shadow DOM
  const barHTML = `
    <div class="gemini-bar" id="geminiBar">
      <div class="gemini-bar-header">
        <span class="gemini-bar-title">&#x2728; Gemini</span>
        <span class="gemini-bar-badge" aria-hidden="true">AI</span>
      </div>
      <div class="gemini-bar-input-row">
        <input type="text" class="gemini-bar-input" id="geminiPromptInput" aria-label="Gemini prompt"
               placeholder="Ask Gemini to write, reply, or improve your email..."
               autocomplete="off" />
        <button class="gemini-bar-btn" id="geminiGenerateBtn">Generate</button>
      </div>
      <div class="gemini-bar-status" id="geminiStatus" role="status" style="display:none;"></div>
    </div>
  `;

  shadow.innerHTML = barHTML;

  // Get references to elements inside shadow DOM
  const input = shadow.getElementById('geminiPromptInput');
  const generateBtn = shadow.getElementById('geminiGenerateBtn');
  const statusEl = shadow.getElementById('geminiStatus');

  // Attach event handlers
  generateBtn.addEventListener('click', () => handleGenerate(composeContainer, input, generateBtn, statusEl));

  // Capture-Phase Event Interception (host-level)
  // Register critical handlers at document capture phase FIRST, so they fire
  // BEFORE the interception handler calls stopImmediatePropagation.
  // Events from shadow DOM are retargeted: e.target === host at document level.

  // Composition tracking at capture phase (must fire before stopImmediatePropagation)
  ['compositionstart', 'compositionend'].forEach(evtName => {
    document.addEventListener(evtName, (e) => {
      if (host.contains(e.target)) {
        if (evtName === 'compositionstart') isComposing = true;
        if (evtName === 'compositionend') isComposing = false;
      }
    }, { signal: ac.signal, capture: true });
  });

  // Safety reset: if IME composition gets stuck (some IMEs don't fire compositionend on cancel),
  // reset isComposing on blur so the Enter shortcut doesn't break permanently
  document.addEventListener('focusout', (e) => {
    if (host.contains(e.target)) {
      isComposing = false;
    }
  }, { signal: ac.signal, capture: true });

  // Enter key shortcut at capture phase (must fire before stopImmediatePropagation)
  document.addEventListener('keydown', (e) => {
    if (host.contains(e.target)) {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        handleGenerate(composeContainer, input, generateBtn, statusEl);
      }
    }
  }, { signal: ac.signal, capture: true });

  // Block Gmail capture-phase handlers from intercepting events targeting our UI.
  // Uses stopImmediatePropagation to prevent Gmail handlers on document from firing,
  // while critical handlers above already processed the event.
  const hostEvents = ["keydown", "keypress", "keyup", "input", "compositionstart", "compositionupdate", "compositionend", "paste", "copy", "cut", "focus", "blur"];
  hostEvents.forEach(evtName => {
    document.addEventListener(evtName, (e) => {
      if (host.contains(e.target)) {
        e.stopImmediatePropagation();
      }
    }, { signal: ac.signal, capture: true });
  });

  // Auto-focus the input when compose opens (small delay for animation)
  setTimeout(() => {
    if (input.isConnected) input.focus();
  }, 300);

// ---------------------------------------------------------------------------
}

// Handle the Generate button click
// ---------------------------------------------------------------------------
async function handleGenerate(composeContainer, input, generateBtn, statusEl) {
  // Prevent duplicate concurrent generations for this compose window
  if (generatingWindows.get(composeContainer)) return;

  const prompt = input.value.trim();
  if (!prompt) {
    showStatus(statusEl, 'Please enter a prompt.', 'error');
    return;
  }
  generatingWindows.set(composeContainer, true);

  // Disable UI during generation
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';
  showStatus(statusEl, 'Reading email context and generating response...', 'info');

  try {
    // Step 1: Read the full page content (email thread context)
    const pageContent = getPageContent() || '';

    // Step 2: Send to background script for Gemini API call
    showStatus(statusEl, 'Sending to Gemini...', 'info');

    const response = await chrome.runtime.sendMessage({
      type: 'GENERATE_REPLY',
      prompt: prompt,
      pageContent: pageContent,
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'No response from extension. Please try again.');
    }

    const generatedText = response.text;

    // Step 3: Write the generated text into the compose area
    const composeArea = findComposeTextarea(composeContainer);
    if (!composeArea) {
      throw new Error('Could not find the compose input area. Please try again.');
    }

    insertTextIntoCompose(composeArea, generatedText);

    // Success
    showStatus(statusEl, 'Response inserted!', 'success');
    input.value = ''; // Clear the prompt

  } catch (error) {
    console.error('[Gemini for Gmail] Generation error:', error);
    showStatus(statusEl, error.message || 'An unexpected error occurred.', 'error');
  } finally {
    generatingWindows.set(composeContainer, false);
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate';
  }
}

// ---------------------------------------------------------------------------
// Read the full page content to provide email context
// ---------------------------------------------------------------------------
function getPageContent() {
  const parts = [];

  // 1. Try to get the email subject
  const subjectEl = document.querySelector('h2.hP');
  if (subjectEl) {
    parts.push('Subject: ' + subjectEl.textContent.trim());
  }

  // 2. Try to get sender/recipient info from the reading pane
  const senderEl = document.querySelector('.gD');  // Sender name
  const senderEmailEl = document.querySelector('.gv'); // Sender email
  if (senderEl) {
    parts.push('From: ' + senderEl.textContent.trim() + (senderEmailEl ? ' <' + senderEmailEl.textContent.trim() + '>' : ''));
  }

  const dateEl = document.querySelector('.g3');
  if (dateEl) {
    parts.push('Date: ' + dateEl.textContent.trim());
  }

  // 3. Try multiple selectors for email body content
  let emailBodyText = '';
  for (const selector of EMAIL_BODY_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim().length > 0) {
      emailBodyText = el.textContent.trim();
      break;
    }
  }

  // Fallback: try to find any div with email content
  if (!emailBodyText) {
    const allA3s = document.querySelectorAll('.a3s');
    for (const el of allA3s) {
      const text = el.textContent.trim();
      if (text.length > emailBodyText.length) {
        emailBodyText = text;
      }
    }
  }

  if (emailBodyText) {
    parts.push('Email content:\n' + emailBodyText.substring(0, 15000)); // Limit to 15k chars
  }

  // 4. Also grab the visible thread content (all messages visible on screen)
  const threadParts = document.querySelectorAll('.ii.gt, .adn.ads, .h7');
  let threadText = '';
  for (const el of threadParts) {
    threadText += el.textContent.trim() + '\n---\n';
  }
  if (threadText && threadText.length > 0) {
    parts.push('Full thread:\n' + threadText.substring(0, 15000));
  }

  return parts.join('\n\n');
}
// ---------------------------------------------------------------------------
// Find the compose textarea within a compose container
// ---------------------------------------------------------------------------
function findComposeTextarea(composeContainer) {
  // Pass 1: search within composeContainer (backward compat)
  let result = findTextareaInRoot(composeContainer);
  if (result) return result;

  // Pass 2: search within the enclosing dialog (modern Gmail: textarea may be
  // outside composeContainer but still in the same compose dialog).
  // This prevents picking up a textarea from a different compose window.
  const dialog = composeContainer.closest('[role="dialog"]');
  if (dialog && dialog !== composeContainer) {
    result = findTextareaInRoot(dialog);
    if (result) return result;
  }

  // Pass 3: last-resort full document scan
  console.warn('[Gemini for Gmail] Falling back to document-wide textarea search');
  result = findTextareaInRoot(document);
  if (result) return result;

  return null;
}

/**
 * Search for the compose textarea within a given root element.
 */
function findTextareaInRoot(root) {
  for (const selector of COMPOSE_TEXTAREA_SELECTORS) {
    const textarea = root.querySelector(selector);
    if (textarea) {
      return textarea;
    }
  }

  // Wide fallback: find the compose textarea among visible contenteditable divs
  const editableDivs = root.querySelectorAll('div[contenteditable="true"]');
  // Helper: robust visibility check (works for fixed/absolute positioning unlike offsetParent)
  const isVisible = (el) => {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    // Fallback for older browsers: walk computed styles (with depth guard)
    let node = el;
    let depth = 0;
    while (node && depth < 200) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      node = node.parentElement;
      depth++;
    }
    return true;
  };
  // Single pass: score each editable div for two tiers simultaneously
  let bestT1 = null, bestT1Size = 0;
  let bestT2 = null, bestT2Size = 0;
  for (const div of editableDivs) {
    if (!isVisible(div)) continue;
    const size = div.offsetHeight * div.offsetWidth;
    // Tier 1: has role="textbox" or aria-label (likely the body textarea)
    if (div.getAttribute('role') === 'textbox' || div.getAttribute('aria-label')) {
      if (size > bestT1Size) { bestT1Size = size; bestT1 = div; }
    }
    // Tier 2: any visible contenteditable (last resort)
    if (size > bestT2Size) { bestT2Size = size; bestT2 = div; }
  }
  if (bestT1) return bestT1;
  if (bestT2) return bestT2;

  return null;
}

// ---------------------------------------------------------------------------
// Insert text into Gmail's compose contenteditable div
// ---------------------------------------------------------------------------
function insertTextIntoCompose(composeArea, text) {
  // Focus the compose area so the cursor is active
  composeArea.focus();

  // We only INSERT at cursor position.
  // The user might want to add AI text to existing draft.

  // --- Method 1: execCommand (most reliable for contenteditable, preserves undo stack) ---
  // document.execCommand is deprecated but still the ONLY reliable way for Gmail's editor.
  try {
    // Ensure we're at the end of the content if no cursor is placed
    const sel = window.getSelection();
    if (!sel.rangeCount || !composeArea.contains(sel.anchorNode)) {
      // Place cursor at the end of compose content
      const range = document.createRange();
      range.selectNodeContents(composeArea);
      range.collapse(false); // false = collapse to end
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // Insert the text
    const success = document.execCommand('insertText', false, text);
    if (!success) {
      // Fallback: execCommand returned false
      throw new Error('execCommand returned false');
    }
  } catch (e) {
    // --- Method 2: Direct innerHTML append (fallback) ---
    console.warn('[Gemini for Gmail] execCommand failed, using innerHTML fallback:', e.message);
    // Convert newlines to <br> for HTML content
    // Sanitize text to prevent XSS -- escape HTML special characters
    const escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const htmlText = escapedText.replace(/\n/g, '<br>');
    // If the compose area is empty, set content directly
    if (!composeArea.textContent.trim()) {
      composeArea.innerHTML = htmlText;
    } else {
      // Append a blank line + the new content
      composeArea.innerHTML += '<br><br>' + htmlText;
    }
  }

  // Dispatch an input event so Gmail registers the change (enables Send button, etc.)
  composeArea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showStatus(statusEl, message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = 'gemini-bar-status ' + type;
  statusEl.style.display = 'block';
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline CSS for Shadow DOM (duplicated from styles.css for isolation)
// ---------------------------------------------------------------------------
function getGeminiBarStyles() {
  return `
    :host {
      all: initial;
      display: block;
      font-family: 'Google Sans', 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      color: #1f1f1f;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    @keyframes geminiSlideIn {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes geminiPulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(20, 184, 166, 0.3);
      }
      50% {
        box-shadow: 0 0 0 6px rgba(20, 184, 166, 0);
      }
    }

    .gemini-bar {
      background: linear-gradient(135deg, #f0fdfa 0%, #ffffff 100%);
      border: 1px solid #99f6e4;
      border-left: 4px solid #14b8a6;
      border-radius: 8px;
      padding: 10px 14px;
      margin: 6px 0 10px 0;
      box-shadow: 0 4px 12px rgba(20, 184, 166, 0.12), 0 1px 3px rgba(0,0,0,0.06);
      animation: geminiSlideIn 0.3s ease-out;
    }

    .gemini-bar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .gemini-bar-title {
      font-size: 11px;
      font-weight: 700;
      color: #0f766e;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .gemini-bar-badge {
      font-size: 9px;
      font-weight: 600;
      color: #fff;
      background: linear-gradient(135deg, #14b8a6, #0d9488);
      padding: 2px 8px;
      border-radius: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .gemini-bar-input-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .gemini-bar-input {
      flex: 1;
      padding: 9px 14px;
      border: 1.5px solid #99f6e4;
      border-radius: 8px;
      font-size: 13px;
      font-family: inherit;
      background: #fff;
      color: #1f1f1f;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      min-height: 20px;
    }


    .gemini-bar-input:hover {
      border-color: #2dd4bf;
    }

    .gemini-bar-input:focus {
      border-color: #14b8a6;
      box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.25);
    }

    .gemini-bar-input::placeholder {
      color: #9aa0a6;
      font-style: italic;
    }

    .gemini-bar-btn {
      padding: 9px 22px;
      background: linear-gradient(135deg, #14b8a6, #0d9488);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: transform 0.15s, box-shadow 0.15s;
      letter-spacing: 0.3px;
      animation: geminiPulse 2s ease-in-out infinite;
      will-change: box-shadow;
    }

    .gemini-bar-btn:hover {
      background: linear-gradient(135deg, #0d9488, #0f766e);
      box-shadow: 0 2px 8px rgba(20, 184, 166, 0.3);
      transform: translateY(-1px);
      animation: none;
    }

    .gemini-bar-btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.3);
    }

    .gemini-bar-btn:active {
      transform: translateY(0);
      box-shadow: none;
    }

    .gemini-bar-btn:disabled {
      background: #ccfbf1;
      color: #5c5c5c;
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
      animation: none;
    }


    @keyframes geminiFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .gemini-bar-status {
      margin-top: 8px;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      font-weight: 500;
      animation: geminiFadeIn 0.2s ease-out;
    }

    .gemini-bar-status.info {
      background: #f0fdfa;
      color: #0d9488;
      border: 1px solid #ccfbf1;
    }

    .gemini-bar-status.success {
      background: #f0fdf4;
      color: #16a34a;
      border: 1px solid #bbf7d0;
    }

    .gemini-bar-status.error {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
    }

    @media (prefers-reduced-motion: reduce) {
      .gemini-bar,
      .gemini-bar-btn,
      .gemini-bar-status {
        animation: none;
      }
    }
  `;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (composeObserver) {
    composeObserver.disconnect();
    composeObserver = null;
  }
  // Abort all active capture-phase listeners
  for (const ctrl of activeAbortControllers) {
    ctrl.abort();
  }
  activeAbortControllers.clear();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Wait for the DOM to be ready before initializing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


