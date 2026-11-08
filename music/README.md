# DJ SEBAS MIX STUDIO

Android two-deck local DJ mixer. No AI, Hugging Face, OpenAI, API keys, or cloud audio processing.

## Features
- Two local audio decks with play/pause, cue, seek and mute.
- Independent volume, low/mid/high EQ and pitch/speed.
- Crossfader and simultaneous playback.
- Record the master mix to WebM where supported.
- Local audio is processed in the device browser/WebView and is not uploaded.

## Web version
Run `npm install` and `npm start` from this directory.

## Android APK
GitHub Actions builds the debug APK and publishes it as a public GitHub Release download. Open the repository Releases page and download `app-debug.apk`.

Android build workflow installs explicit SDK platform and build-tools packages using the hosted Android SDK command-line tools.
