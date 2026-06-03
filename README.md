# node-apple-speech

Node.js module for Apple SpeechAnalyzer transcription on macOS 26+.

The JavaScript API follows the [`whisper.node`](https://github.com/mybigday/whisper.node) context shape where possible:

```js
const { initAppleSpeech } = require('node-apple-speech')

const context = await initAppleSpeech({ language: 'en_US' })
const { stop, promise } = context.transcribeData(pcm16ArrayBuffer, {
  sampleRate: 48000,
  channels: 2,
  bitsPerSample: 16,
})

const result = await promise
await context.release()
```

`transcribeData` accepts raw 16-bit PCM audio, matching the realtime transcription contract used by [`whisper.rn`](https://github.com/mybigday/whisper.rn/tree/main/src/realtime-transcription). It returns:

```ts
{
  stop: () => Promise<void>
  promise: Promise<{
    language: string
    result: string
    segments: Array<{ text: string; t0: number; t1: number }>
    duration?: number
    isAborted: boolean
  }>
}
```

## Audio Input Format

`transcribeData(audioData, options)` accepts raw 16-bit PCM data. Set `sampleRate`, `channels`, and `bitsPerSample` to match the buffer.

- `bitsPerSample` must be `16`.
- Mono audio uses one signed little-endian PCM sample per frame.
- Stereo audio is supported. Pass `channels: 2` and provide interleaved signed little-endian PCM samples: left frame 0, right frame 0, left frame 1, right frame 1, and so on.
- More than two channels may be accepted by the JavaScript WAV wrapper, but only mono and stereo are currently verified.

`transcribeFile(filePath, options)` reads through `AVAudioFile`, so it can transcribe mono or stereo files supported by AVFoundation.

For realtime callers, make sure any upstream VAD, slicing, or duration calculation is channel-aware. If that pipeline assumes mono PCM16, downmix stereo capture to mono before calling `transcribeData`.

## Requirements

- macOS 26.0+
- Xcode command line tools with Swift 6.3+
- Node.js 18+

## Build

```sh
npm install
npm run build
```

The build compiles `native/apple-speech-helper.swift` into `build/Release/node-apple-speech-helper`.

## Examples

Generate a local macOS `say` fixture and call `transcribeData`:

```sh
npm run example:transcribe-data
```

Transcribe an existing audio file supported by `AVAudioFile`:

```sh
node examples/transcribe-file.js /path/to/audio.wav
```

Run the same `transcribeData` path from an Electron main process:

```sh
npm run example:electron-main
```

## Tests

API and helper smoke tests:

```sh
npm test
```

Real local transcription tests:

```sh
npm run test:transcribe
```

The transcribe tests generate speech with `say`, convert it to 16-bit mono WAV with `afconvert`, and verify both `transcribeData` and `transcribeFile`.

## Release

Create a local release tarball:

```sh
npm run release
```

The release script runs `npm test`, builds the local macOS helper, and writes the package tarball to `dist/`.

Useful options:

```sh
npm run release -- --skip-tests
npm run release -- --publish
npm run release -- --publish --dry-run
npm run release -- --require-clean
```

Publishing uses `NPM_TOKEN` when present and skips `npm publish` if the current package version already exists on npm.

## CI

The GitHub Actions workflow in `.github/workflows/ci.yml` runs on `macos-26` with Node.js 20 and 22. It installs dependencies, builds the Swift helper, runs `npm test`, and verifies the release tarball can be packed locally.

## API

- `initAppleSpeech(options)` creates a context.
- `initWhisper(options)` is an alias for compatibility with whisper-style callers.
- `context.transcribeData(audioData, options)` is the key realtime-compatible API.
- `context.transcribeFile(filePath, options)` transcribes an audio file supported by Apple AVFoundation.
- `context.transcribe(filePath, options)` aliases `transcribeFile`.
- `context.prepare(language?)` installs SpeechAnalyzer assets for a locale.
- `isAppleSpeechAvailable({ language })` checks SpeechTranscriber availability.

Unsupported Whisper decoding options such as `temperature`, `beamSize`, and `translate` are accepted for caller compatibility but ignored by Apple SpeechAnalyzer.

## Electron

This module works from the Electron main process. The verified command is:

```sh
npm run example:electron-main
```

That command starts Electron, runs in `process.type === 'browser'`, creates local audio with `say`, and transcribes it through `context.transcribeData`.

Use this module in the main process, a preload script, or another Node-enabled Electron process. Do not expose it directly to untrusted renderer code; route renderer requests through IPC if needed.

For packaged Electron apps, make sure the Swift helper is available as a real executable file. Electron can `require` JavaScript from `app.asar`, but spawned executables should be unpacked. Configure your packager to unpack:

```text
node_modules/node-apple-speech/build/Release/node-apple-speech-helper
```

For example, with electron-builder:

```json
{
  "build": {
    "asarUnpack": [
      "node_modules/node-apple-speech/build/Release/node-apple-speech-helper"
    ]
  }
}
```

The package automatically checks the matching `app.asar.unpacked` path. You can also override the helper location with `NODE_APPLE_SPEECH_HELPER_PATH` or `initAppleSpeech({ helperPath })`.

When signing/notarizing a packaged macOS app, include and sign the unpacked helper with the rest of the app bundle.

## macOS Settings

For the current `SpeechAnalyzer`/`SpeechTranscriber` backend and prerecorded audio passed to `transcribeData` or `transcribeFile`, no microphone permission was required in local Node or Electron main-process verification.

Settings and permissions that can matter:

- Speech assets: `context.prepare()` may download on-device speech models through Apple `AssetInventory`. The first run for a locale may need network access and can take longer.
- Sandboxed apps: if your packaged Electron app is sandboxed and needs to download speech assets, enable outgoing network access with `com.apple.security.network.client`.
- Microphone capture: this package does not record from the microphone. If your Electron app captures live audio for realtime transcription, add `NSMicrophoneUsageDescription` to the app `Info.plist` and grant Microphone access in System Settings > Privacy & Security > Microphone.
- Server speech recognition APIs: this package uses on-device `SpeechAnalyzer`, not Apple server speech recognition. If you add an `SFSpeechRecognizer`/server-recognition path elsewhere, add `NSSpeechRecognitionUsageDescription` and expect Speech Recognition privacy authorization.

## License

MIT

---

<p align="center">
  <a href="https://bricks.tools">
    <img width="90px" src="https://avatars.githubusercontent.com/u/17320237?s=200&v=4">
  </a>
  <p align="center">
    Built and maintained by <a href="https://bricks.tools">BRICKS</a>.
  </p>
</p>
