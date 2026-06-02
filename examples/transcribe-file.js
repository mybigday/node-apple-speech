'use strict'

const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { initAppleSpeech } = require('..')

function formatMs(value) {
  return `${value.toFixed(1)}ms`
}

function printTiming(label, value) {
  process.stderr.write(`[perf] ${label}: ${formatMs(value)}\n`)
}

async function main() {
  const start = performance.now()
  const filePath = process.argv[2]

  if (!filePath) {
    throw new Error('Usage: node examples/transcribe-file.js /path/to/audio.wav')
  }

  const initStart = performance.now()
  const context = await initAppleSpeech({ language: 'en_US' })
  const initMs = performance.now() - initStart

  try {
    const transcribeStart = performance.now()
    const { promise } = context.transcribeFile(path.resolve(filePath))
    const result = await promise
    const transcribeMs = performance.now() - transcribeStart

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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
