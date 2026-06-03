'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { app } = require('electron')
const { initAppleSpeech } = require('..')
const { decodeWav } = require('../lib/wav')

function formatMs(value) {
  return `${value.toFixed(1)}ms`
}

function printTiming(label, value) {
  process.stderr.write(`[perf] ${label}: ${formatMs(value)}\n`)
}

function getLanguage() {
  return process.env.NODE_APPLE_SPEECH_LANGUAGE || 'en_US'
}

function commandExists(command) {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0
}

function preferredSayVoiceArgs() {
  const voices = spawnSync('say', ['-v', '?'], { encoding: 'utf8' })

  if (voices.status === 0 && /^Samantha\s+en_US/m.test(voices.stdout)) {
    return ['-v', 'Samantha']
  }

  return []
}

function createSpeechFixture() {
  if (!commandExists('say') || !commandExists('afconvert')) {
    throw new Error('say and afconvert are required for this Electron example')
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-apple-speech-electron-'))
  const aiff = path.join(dir, 'speech.aiff')
  const wav = path.join(dir, 'speech.wav')
  const text = 'Hello world. This is an Apple speech transcription test.'

  let result = spawnSync('say', [...preferredSayVoiceArgs(), '-r', '160', '-o', aiff, text], {
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || 'say failed')
  }

  result = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav], {
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || 'afconvert failed')
  }

  return { dir, wav }
}

async function run() {
  const start = performance.now()
  const fixtureStart = performance.now()
  const fixture = createSpeechFixture()
  const fixtureMs = performance.now() - fixtureStart

  try {
    const wav = decodeWav(fs.readFileSync(fixture.wav))
    const initStart = performance.now()
    const context = await initAppleSpeech({ language: getLanguage() })
    const initMs = performance.now() - initStart

    try {
      const transcribeStart = performance.now()
      const { promise } = context.transcribeData(wav.data, {
        sampleRate: wav.sampleRate,
        channels: wav.channels,
        bitsPerSample: wav.bitsPerSample,
      })
      const result = await promise
      const transcribeMs = performance.now() - transcribeStart

      process.stderr.write(`[electron] process.type: ${process.type}\n`)
      process.stderr.write(`[electron] version: ${process.versions.electron}\n`)
      process.stderr.write(`[config] language: ${getLanguage()}\n`)
      printTiming('fixture', fixtureMs)
      printTiming('init-context', initMs)
      printTiming('transcribe', transcribeMs)
      if (result.duration > 0) {
        process.stderr.write(`[perf] audio: ${result.duration.toFixed(3)}s\n`)
        process.stderr.write(`[perf] realtime-factor: ${(transcribeMs / 1000 / result.duration).toFixed(3)}x\n`)
      }
      printTiming('total', performance.now() - start)

      console.log(JSON.stringify(result, null, 2))
    } finally {
      await context.release()
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
