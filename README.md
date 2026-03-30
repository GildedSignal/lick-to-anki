# Lick to Anki

Capture guitar phrases from YouTube videos and create Anki flashcards in seconds.

**Flow:** Watch a YouTube lesson → mark start/end of a phrase → get an Anki card with the audio clip on the front and a timestamped YouTube link on the back.

No server to run. Chrome launches the extraction script on demand via native messaging.

## Setup

### 1. Install yt-dlp and ffmpeg

```bash
brew install yt-dlp ffmpeg
```

### 2. Install AnkiConnect

1. Open Anki
2. Tools → Add-ons → Get Add-ons
3. Enter code: `2055492159`
4. Restart Anki

### 3. Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" → select the `extension/` folder
4. Copy the extension ID shown on the card

### 4. Register the native host

```bash
python3 install.py <your-extension-id>
```

Then restart Chrome.

Audio files are saved to `~/Music/Guitar Phrases/`.

## Usage

1. Go to any YouTube video
2. Click the Lick to Anki extension icon
3. Play to where the phrase starts → **Mark Start**
4. Seek to where the phrase ends → **Mark End**
5. (Optional) Edit the card name, toggle loop to preview
6. **Create Anki Card**

Cards go into the "Guitar Phrases" deck:
- **Front:** extracted audio clip
- **Back:** timestamped YouTube link + "[record yourself, then compare]"

## Status indicators

- Green dot = connected
- Red dot = not reachable (check that Anki is open / native host is installed)
