/**
 * Options page logic for Gemini for Gmail.
 * Saves API key and model preference to chrome.storage.sync.
 * Provides Test button to validate the API key against Gemini API.
 */

const DEFAULT_MODEL = 'gemini-flash-lite-latest';

/** Show a status message to the user */
function showStatus(elements, message, type = 'info') {
  elements.status.textContent = message;
  elements.status.className = type;
}

/** Load saved settings from chrome.storage.sync */
async function loadSettings(elements) {
  try {
    const result = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
    if (result.geminiApiKey) {
      elements.apiKey.value = result.geminiApiKey;
    }
    if (result.geminiModel) {
      elements.model.value = result.geminiModel;
    } else {
      elements.model.value = DEFAULT_MODEL;
    }
  } catch (err) {
    console.error('[Gemini for Gmail] Failed to load settings:', err);
    showStatus(elements, 'Failed to load saved settings.', 'error');
  }
}

/** Save settings to chrome.storage.sync */
async function saveSettings(elements) {
  const apiKey = elements.apiKey.value.trim();
  const model = elements.model.value;

  if (!apiKey) {
    showStatus(elements, 'Please enter an API key.', 'error');
    return;
  }

  if (!apiKey.startsWith('AIza')) {
    showStatus(elements, 'Invalid API key format. Gemini API keys start with "AIza".', 'error');
    return;
  }

  try {
    await chrome.storage.sync.set({
      geminiApiKey: apiKey,
      geminiModel: model,
    });
    showStatus(elements, 'Settings saved successfully!', 'success');
  } catch (err) {
    console.error('[Gemini for Gmail] Failed to save settings:', err);
    showStatus(elements, 'Failed to save settings: ' + err.message, 'error');
  }
}

/** Test the API key by making a lightweight call to Gemini */
async function testApiKey(elements) {
  const apiKey = elements.apiKey.value.trim();
  const model = elements.model.value;

  if (!apiKey) {
    showStatus(elements, 'Please enter an API key first.', 'error');
    return;
  }

  elements.testBtn.disabled = true;
  elements.testBtn.textContent = 'Testing...';
  showStatus(elements, 'Testing API key...', 'testing');

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), 15000)
    );
    const response = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'TEST_API_KEY',
        apiKey: apiKey,
        model: model,
      }),
      timeout,
    ]);

    if (!response) {
      showStatus(elements, 'Extension service worker unavailable. Please reload the extension.', 'error');
      return;
    }

    if (response.success) {
      showStatus(elements, 'API key is valid! Connection successful.', 'success');
    } else {
      showStatus(elements, 'API key test failed: ' + (response.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showStatus(elements, 'Failed to reach extension: ' + err.message, 'error');
  } finally {
    elements.testBtn.disabled = false;
    elements.testBtn.textContent = 'Test API Key';
  }
}

/** Clear the API key from storage */
async function clearApiKey(elements) {
  try {
    await chrome.storage.sync.remove(['geminiApiKey']);
    elements.apiKey.value = '';
    showStatus(elements, 'API key cleared.', 'info');
  } catch (err) {
    console.error('[Gemini for Gmail] Failed to clear API key:', err);
    showStatus(elements, 'Failed to clear API key: ' + err.message, 'error');
  }
}

// --- Initialization: Defer all DOM access until DOM is ready ---
document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    apiKey: document.getElementById('apiKey'),
    model: document.getElementById('model'),
    saveBtn: document.getElementById('saveBtn'),
    testBtn: document.getElementById('testBtn'),
    clearBtn: document.getElementById('clearBtn'),
    status: document.getElementById('status'),
  };

  // Guard: verify all elements exist
  if (!elements.apiKey || !elements.model || !elements.saveBtn || !elements.testBtn || !elements.clearBtn || !elements.status) {
    console.error('[Gemini for Gmail] Options page: One or more required DOM elements not found.');
    return;
  }

  // Load saved settings (with error handling)
  loadSettings(elements);

  // Event listeners
  elements.saveBtn.addEventListener('click', () => saveSettings(elements));
  elements.testBtn.addEventListener('click', () => testApiKey(elements));
  elements.clearBtn.addEventListener('click', () => clearApiKey(elements));

  elements.apiKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveSettings(elements);
  });
});
