/**
 * Background Service Worker for Gemini for Gmail.
 *
 * Responsibilities:
 * - Listen for messages from content script and options page
 * - Make Gemini API calls (fetch) — avoids CORS issues by running in background
 * - Proxy API test requests from options page
 * - Handle errors and return structured responses
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Call the Gemini API to generate content.
 * @param {string} prompt - The user's prompt text
 * @param {string} pageContent - The full email thread / page text content
 * @param {string} apiKey - Gemini API key
 * @param {string} model - Model name (e.g. 'gemini-flash-lite-latest')
 * @returns {Promise<string>} - The generated text response
 */
async function callGeminiAPI(prompt, pageContent, apiKey, model) {
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const userMessage = {
    role: 'user',
    parts: [{
      text: `You are an expert email assistant integrated into Gmail. 
Your task is to help the user compose or reply to emails.

The user will provide you with:
1. The current email thread / page content (context)
2. A prompt describing what they want to write

Instructions:
- Use the email thread context to understand the conversation.
- Write in a professional, clear, and appropriate tone for the context.
- Do NOT wrap your response in markdown code blocks unless explicitly requested.
- Output plain text that can be directly inserted into an email body.
- If the user asks for a specific format (bullet points, numbered list), use plain text formatting.
- Keep responses concise and actionable.

=== EMAIL THREAD / PAGE CONTENT ===
${pageContent}

=== USER PROMPT ===
${prompt}

=== OUTPUT ===`
    }]
  };

  const requestBody = {
    contents: [userMessage],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
      topP: 0.95,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMessage = data.error?.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(`Gemini API error: ${errorMessage}`);
  }

  // Extract the generated text from the response
  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error('Gemini API returned no candidates. The response may have been blocked by safety filters.');
  }

  const parts = candidates[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error('Gemini API returned empty content parts.');
  }

  const generatedText = parts.map(p => p.text || '').join('').trim();

  if (!generatedText) {
    throw new Error('Gemini API returned an empty response.');
  }

  return generatedText;
}

/**
 * Test if an API key is valid by making a minimal request.
 * @param {string} apiKey - The API key to test
 * @param {string} model - The model name
 * @returns {Promise<boolean>}
 */
async function testApiKey(apiKey, model) {
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Say "ok" and nothing else.' }] }],
      generationConfig: { maxOutputTokens: 10 },
    }),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Message handler — receives messages from content script and options page
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle the request asynchronously
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error('[Gemini for Gmail] Error handling message:', error);
      sendResponse({ success: false, error: error.message || 'Unknown error' });
    });

  // Return true to keep the message channel open for async response
  return true;
});

/**
 * Route and handle incoming messages.
 */
async function handleMessage(message, sender) {
  switch (message.type) {
    case 'GENERATE_REPLY': {
      // message: { type, prompt, pageContent }
      // Load the API key and model from storage
      const storage = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
      const apiKey = storage.geminiApiKey;
      const model = storage.geminiModel || 'gemini-flash-lite-latest';

      if (!apiKey) {
        throw new Error('API key not configured. Please open the extension options to set your Gemini API key.');
      }

      const generatedText = await callGeminiAPI(message.prompt, message.pageContent, apiKey, model);
      return { success: true, text: generatedText };
    }

    case 'TEST_API_KEY': {
      // message: { type, apiKey, model }
      await testApiKey(message.apiKey, message.model);
      return { success: true };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

// Log that the service worker has started (useful for debugging)
console.log('[Gemini for Gmail] Service worker started.');
