'use strict'

const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { initAppleSpeech } = require('..')
const { decodeWav } = require('../lib/wav')

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-apple-speech-test-'))
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

test('transcribeData recognizes generated macOS speech', { timeout: 240000 }, async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS only')
    return
  }

  if (process.env.RUN_APPLE_SPEECH_TRANSCRIBE !== '1') {
    t.skip('set RUN_APPLE_SPEECH_TRANSCRIBE=1 to run native transcription')
    return
  }

  if (!commandExists('say') || !commandExists('afconvert')) {
    t.skip('say and afconvert are required for generated audio fixture')
    return
  }

  const fixture = createSpeechFixture()
  const context = await initAppleSpeech({ language: 'en_US', prepare: true })

  try {
    const wav = decodeWav(fs.readFileSync(fixture.wav))
    const { promise } = context.transcribeData(wav.data, {
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      bitsPerSample: wav.bitsPerSample,
      timeoutMs: 180000,
    })
    const result = await promise

    assert.equal(result.isAborted, false)
    assert.ok(result.result.length > 0, 'expected non-empty transcription')
    assert.match(result.result.toLowerCase(), /hello|apple|speech/)
    assert.ok(Array.isArray(result.segments))
  } finally {
    await context.release()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('transcribeFile recognizes generated macOS speech', { timeout: 240000 }, async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS only')
    return
  }

  if (process.env.RUN_APPLE_SPEECH_TRANSCRIBE !== '1') {
    t.skip('set RUN_APPLE_SPEECH_TRANSCRIBE=1 to run native transcription')
    return
  }

  if (!commandExists('say') || !commandExists('afconvert')) {
    t.skip('say and afconvert are required for generated audio fixture')
    return
  }

  const fixture = createSpeechFixture()
  const context = await initAppleSpeech({ language: 'en_US', prepare: true })

  try {
    const { promise } = context.transcribeFile(fixture.wav, {
      timeoutMs: 180000,
    })
    const result = await promise

    assert.equal(result.isAborted, false)
    assert.ok(result.result.length > 0, 'expected non-empty transcription')
    assert.match(result.result.toLowerCase(), /hello|apple|speech/)
  } finally {
    await context.release()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})
