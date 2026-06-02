'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const source = path.join(root, 'native', 'apple-speech-helper.swift')
const outputDir = path.join(root, 'build', 'Release')
const output = path.join(outputDir, 'node-apple-speech-helper')

if (process.platform !== 'darwin') {
  console.error('node-apple-speech only supports macOS because it uses Apple Speech.framework.')
  process.exit(1)
}

fs.mkdirSync(outputDir, { recursive: true })

const result = spawnSync(
  'swiftc',
  [
    '-O',
    '-parse-as-library',
    '-o',
    output,
    source,
  ],
  {
    cwd: root,
    stdio: 'inherit',
  },
)

if (result.status !== 0) {
  process.exit(result.status || 1)
}

fs.chmodSync(output, 0o755)
console.log(`Built ${path.relative(root, output)}`)
