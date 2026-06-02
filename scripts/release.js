'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const distDir = path.join(root, 'dist')
const packageJson = require('../package.json')

function usage() {
  console.log(`Usage: npm run release -- [options]

Builds the local macOS helper, runs tests, creates an npm tarball, and optionally publishes it.

Options:
  --publish              Publish the packed tarball when this version is not already on npm.
  --dry-run              Pass --dry-run to npm publish. Implies --publish.
  --skip-tests           Build and pack without running npm test.
  --require-clean        Fail if git has uncommitted changes.
  --tag <tag>            npm dist-tag for publish. Default: latest.
  --pack-destination <dir>
                         Output directory for npm pack. Default: dist.
  --help                 Show this help.
`)
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    packDestination: distDir,
    publish: false,
    requireClean: false,
    skipTests: false,
    tag: 'latest',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--dry-run') {
      options.dryRun = true
      options.publish = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--pack-destination') {
      index += 1
      if (!argv[index]) throw new Error('--pack-destination requires a value')
      options.packDestination = path.resolve(root, argv[index])
    } else if (arg === '--publish') {
      options.publish = true
    } else if (arg === '--require-clean') {
      options.requireClean = true
    } else if (arg === '--skip-tests') {
      options.skipTests = true
    } else if (arg === '--tag') {
      index += 1
      if (!argv[index]) throw new Error('--tag requires a value')
      options.tag = argv[index]
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`)

  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: options.encoding || 'utf8',
    env: {
      ...process.env,
      ...options.env,
    },
    shell: process.platform === 'win32',
    stdio: options.stdio || 'inherit',
  })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }

  return result
}

function readOutput(command, args, options = {}) {
  const result = run(command, args, {
    ...options,
    stdio: 'pipe',
  })

  return result.stdout.trim()
}

function assertMacOS() {
  if (process.platform !== 'darwin') {
    throw new Error('Release builds must run on macOS because the package includes an Apple Speech helper binary.')
  }
}

function assertCleanGit() {
  const status = readOutput('git', ['status', '--short'])

  if (status) {
    throw new Error(`Working tree is not clean:\n${status}`)
  }
}

function configureNpmToken(registry) {
  if (!process.env.NPM_TOKEN) {
    return
  }

  const registryHost = new URL(registry).host
  run('npm', ['config', 'set', `//${registryHost}/:_authToken=${process.env.NPM_TOKEN}`])
}

function getRegistry() {
  return packageJson.publishConfig?.registry || 'https://registry.npmjs.org/'
}

function isPublished(registry) {
  const result = spawnSync('npm', ['view', `${packageJson.name}@${packageJson.version}`, 'version', '--registry', registry], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: 'pipe',
  })

  if (result.status !== 0) {
    return false
  }

  return result.stdout.trim() === packageJson.version
}

function pack(packDestination) {
  fs.mkdirSync(packDestination, { recursive: true })

  const output = readOutput('npm', ['pack', '--json', '--pack-destination', packDestination])
  const lines = output.split(/\r?\n/)
  const jsonStart = lines.findIndex((line) => line.trim() === '[')
  const json = jsonStart >= 0 ? lines.slice(jsonStart).join('\n') : output
  const parsed = JSON.parse(json)
  const filename = parsed[0]?.filename

  if (!filename) {
    throw new Error('npm pack did not return a tarball filename')
  }

  return path.join(packDestination, filename)
}

function publish(tarball, options) {
  const registry = getRegistry()
  configureNpmToken(registry)

  if (isPublished(registry)) {
    console.log(`${packageJson.name}@${packageJson.version} is already published; skipping npm publish.`)
    return
  }

  const args = ['publish', tarball, '--registry', registry, '--tag', options.tag]

  if (options.dryRun) {
    args.push('--dry-run')
  }

  run('npm', args)
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    usage()
    return
  }

  assertMacOS()

  if (options.requireClean) {
    assertCleanGit()
  }

  if (options.skipTests) {
    run('npm', ['run', 'build'])
  } else {
    run('npm', ['test'])
  }

  const tarball = pack(options.packDestination)
  console.log(`Packed ${path.relative(root, tarball)}`)

  if (options.publish) {
    publish(tarball, options)
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
