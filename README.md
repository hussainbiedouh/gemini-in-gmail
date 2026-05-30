# Gemini for Gmail

A **Chromium browser extension** that integrates Google Gemini AI directly into Gmail to help you compose, reply, and refine emails with AI-powered assistance.

## Features

- **AI-Powered Email Composition** — Generate professional email replies from simple prompts
- **Smart Context Awareness** — Automatically reads the current email thread to provide relevant responses
- **Seamless Inline UI** — Non-intrusive bar appears inside Gmail's compose window — no pop-ups or side panels
- **Multiple Gemini Models** — Choose from gemini-2.0-flash, gemini-2.5-flash, or the recommended gemini-flash-lite-latest
- **API Key Testing** — Built-in test button in the options page to validate your API key before use
- **Privacy-First** — Your API key is stored in chrome.storage.sync and never sent anywhere except directly to Google's Gemini API
- **Manifest V3** — Built on the latest Chromium extension platform

## Installation

1. **Download or clone** this repository:
   `ash
   git clone https://github.com/hussainbiedouh/gemini-in-gmail.git
   `
2. Open your **Chromium browser** (Chrome, Edge, Brave, Opera, Vivaldi, etc.) and navigate to the extensions page (chrome://extensions or edge://extensions)
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the gemini-in-gmail folder
6. The extension icon will appear in your browser toolbar

## Getting a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **Get API Key**
3. Select or create a Google Cloud project
4. Copy your new API key (it starts with AIza...)
5. Click the extension icon in the browser toolbar to open the options page
6. Paste your API key and click **Save**
7. (Optional) Click **Test API Key** to verify it works

> **Note:** Gemini API usage may incur charges. Check [Google's pricing page](https://ai.google.dev/pricing) for details.

## Usage

1. Open [Gmail](https://mail.google.com) in your browser
2. Click **Compose** or **Reply** to open a compose window
3. A **"Gemini for Gmail"** bar appears above the compose toolbar
4. Type a prompt describing the email you want to write (e.g., *"Reply thanking them for the update and confirm the meeting"*)
5. Click **Generate**
6. Review the generated text — it will be inserted directly into the email body
7. Edit and send as usual

## Tech Stack

- **Chromium Extension Manifest V3** — Works on Chrome, Edge, Brave, Opera, Vivaldi, and all Chromium-based browsers
- **Google Gemini API** (generativelanguage.googleapis.com/v1beta) — AI text generation
- **Vanilla JavaScript** — No frameworks; lightweight and fast
- **Shadow DOM** — Style isolation for injected UI elements
- **chrome.storage.sync** — Secure cross-device API key storage

## Project Structure

`
gemini-in-gmail/
├── background.js        # Service worker — proxies Gemini API calls
├── content.js           # Content script — injects UI into Gmail
├── manifest.json        # Extension manifest (Manifest V3)
├── options.html         # Options page — API key & model config
├── options.js           # Options page logic
├── styles.css           # Global / fallback styles
└── icons/
    └── icon128.png      # Extension icon
`

## License

MIT
