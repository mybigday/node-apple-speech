'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  AppleSpeechContext,
  getAppleSpeechVersion,
  initAppleSpeech,
  isAppleSpeechAvailable,
} = require('..')
const { decodeWav, encodeWav } = require('../lib/wav')

test('exports whisper-compatible context API', async () => {
  const context = await initAppleSpeech({ language: 'en_US', prepare: false })

  assert.equal(typeof context.transcribeData, 'function')
  assert.equal(typeof context.transcribeFile, 'function')
  assert.equal(typeof context.transcribe, 'function')
  assert.equal(typeof context.release, 'function')
  assert.equal(context.getModelInfo().backend, 'SpeechAnalyzer')

  await context.release()
  assert.throws(() => context.transcribeFile('/tmp/missing.wav'), /released/)
})

test('AppleSpeechContext can be constructed directly', () => {
  const context = new AppleSpeechContext({ language: 'en_US', prepare: false })
  assert.equal(context.getModelInfo().language, 'en_US')
})

test('WAV encoder and decoder round trip 16-bit PCM metadata', () => {
  const pcm = Buffer.alloc(16000 * 2)
  const wav = encodeWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 })
  const decoded = decodeWav(wav)

  assert.equal(decoded.sampleRate, 16000)
  assert.equal(decoded.channels, 1)
  assert.equal(decoded.bitsPerSample, 16)
  assert.equal(decoded.data.length, pcm.length)
})

test('native helper reports version and availability shape', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS only')
    return
  }

  const version = await getAppleSpeechVersion()
  assert.equal(version.backend, 'SpeechAnalyzer')

  const availability = await isAppleSpeechAvailable({ language: 'en_US' })
  assert.equal(typeof availability.available, 'boolean')
  assert.equal(typeof availability.language, 'string')
})
