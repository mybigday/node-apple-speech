'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { initAppleSpeech } = require('..')
const { decodeWav } = require('../lib/wav')

function formatMs(value) {
  return `${value.toFixed(1)}ms`
}

function printTiming(label, value) {
  process.stderr.write(`[perf] ${label}: ${formatMs(value)}\n`)
}

function audioDurationSeconds(wav) {
  return wav.data.length / (wav.channels * (wav.bitsPerSample / 8)) / wav.sampleRate
}

function requireCommand(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Missing required macOS command: ${command}`)
  }
}

function preferredSayVoiceArgs() {
  const voices = spawnSync('say', ['-v', '?'], { encoding: 'utf8' })

  if (voices.status === 0 && /^Samantha\s+en_US/m.test(voices.stdout)) {
    return ['-v', 'Samantha']
  }

  return []
}

function createSpeechFixture() {
  requireCommand('say')
  requireCommand('afconvert')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-apple-speech-example-'))
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

async function main() {
  const start = performance.now()
  const input = process.argv[2]
  const fixtureStart = performance.now()
  const fixture = input ? null : createSpeechFixture()
  const fixtureMs = performance.now() - fixtureStart
  const wavPath = input ? path.resolve(input) : fixture.wav
  const readStart = performance.now()
  const wav = decodeWav(fs.readFileSync(wavPath))
  const readMs = performance.now() - readStart
  const initStart = performance.now()
  const context = await initAppleSpeech({ language: 'en_US' })
  const initMs = performance.now() - initStart

  try {
    const transcribeStart = performance.now()
    const { promise } = context.transcribeData(wav.data.buffer.slice(wav.data.byteOffset, wav.data.byteOffset + wav.data.byteLength), {
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      bitsPerSample: wav.bitsPerSample,
      onProgress(progress) {
        process.stderr.write(`progress ${progress}%\n`)
      },
    })

    const result = await promise
    const transcribeMs = performance.now() - transcribeStart
    const audioSeconds = result.duration || audioDurationSeconds(wav)

    if (!input) {
      printTiming('fixture', fixtureMs)
    }
    printTiming('read-wav', readMs)
    printTiming('init-context', initMs)
    printTiming('transcribe', transcribeMs)
    if (audioSeconds > 0) {
      process.stderr.write(`[perf] audio: ${audioSeconds.toFixed(3)}s\n`)
      process.stderr.write(`[perf] realtime-factor: ${(transcribeMs / 1000 / audioSeconds).toFixed(3)}x\n`)
    }
    printTiming('total', performance.now() - start)

    console.log(JSON.stringify(result, null, 2))
  } finally {
    await context.release()
    if (fixture) {
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
