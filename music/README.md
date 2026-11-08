# DJ SEBAS MIX STUDIO

A local two-deck DJ mixer for Android and modern browsers. No AI, Hugging Face, OpenAI, API keys, or cloud audio processing.

## Features
- Load two local audio files from the device (MP3, WAV, M4A, OGG, FLAC where supported by the browser).
- Two independent decks with play/pause, cue-to-start, seek and mute.
- Per-deck volume, low/mid/high EQ, and pitch/speed adjustment.
- Crossfader and simultaneous playback.
- Record the master mix to a WebM audio file when supported by the browser.
- Audio files are selected and processed locally in the device browser/WebView; they are not uploaded to the server.

## Run the web version
```sh
cd music
npm install
npm start
```

## Build Android APK
The GitHub Actions workflow `.github/workflows/music-android.yml` builds a debug APK for branch `dj-sebas-ai-music`. Download the artifact named `DJ-SEBAS-MIX-STUDIO-APK` from the completed workflow run.
