import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeWav } from './wav'

export interface NativeContextOptions {
  filePath?: string
  model?: string
  language?: string
  locale?: string
  localeIdentifier?: string
  useFlashAttn?: boolean
  useGpu?: boolean
  helperPath?: string
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  prepare?: boolean
  autoPrepare?: boolean
}

export interface TranscribeOptions {
  language?: string
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  offset?: number
  duration?: number
  prompt?: string
  translate?: boolean
  maxThreads?: number
  maxContext?: number
  maxLen?: number
  tokenTimestamps?: boolean
  tdrzEnable?: boolean
  wordThold?: number
  temperature?: number
  temperatureInc?: number
  beamSize?: number
  bestOf?: number
  nProcessors?: number
  prepare?: boolean
  autoPrepare?: boolean
  timeoutMs?: number
  helperPath?: string
  onProgress?: (progress: number) => void
  onNewSegments?: (result: TranscribeNewSegmentsResult) => void
}

export interface TranscribeSegment {
  text: string
  t0: number
  t1: number
}

export interface TranscribeResult {
  language: string
  result: string
  segments: TranscribeSegment[]
  duration?: number
  isAborted: boolean
}

export interface TranscribeNewSegmentsResult {
  nNew: number
  totalNNew: number
  result: string
  segments: TranscribeSegment[]
}

export interface AvailabilityResult {
  available: boolean
  language: string
}

export interface PrepareResult {
  prepared: boolean
  language: string
}

export interface VersionResult {
  backend: string
  minimumMacOS: string
}

export type LibVariant = 'default' | 'vulkan' | 'cuda'

interface HelperOptions {
  helperPath?: string
  timeoutMs?: number
}

interface LanguageOptions extends HelperOptions {
  language?: string
  locale?: string
  localeIdentifier?: string
}

interface SliceOptions {
  sampleRate: number
  channels: number
  bitsPerSample: number
  offset?: number
  duration?: number
}

interface TranscriptionRunOptions extends TranscribeOptions {
  language: string
}

export interface TranscriptionRequest {
  stop: () => Promise<void>
  promise: Promise<TranscribeResult>
}

const DEFAULT_HELPER_PATH = path.join(__dirname, '..', 'build', 'Release', 'node-apple-speech-helper')
const DEFAULT_LANGUAGE = 'en_US'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

function ensureMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('node-apple-speech only supports macOS.')
  }
}

function getAsarUnpackedPath(filePath: string): string | null {
  const marker = `${path.sep}app.asar${path.sep}`

  if (!filePath.includes(marker)) {
    return null
  }

  return filePath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
}

function getHelperCandidates(options: HelperOptions = {}): string[] {
  const candidates = [
    options.helperPath,
    process.env.NODE_APPLE_SPEECH_HELPER_PATH,
    DEFAULT_HELPER_PATH,
    getAsarUnpackedPath(DEFAULT_HELPER_PATH),
  ].filter((candidate): candidate is string => Boolean(candidate))

  return [...new Set(candidates)]
}

function ensureHelper(options: HelperOptions = {}): string {
  ensureMacOS()

  for (const candidate of getHelperCandidates(options)) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Native helper is missing. Run "npm run build" before using node-apple-speech. Checked: ${getHelperCandidates(options).join(', ')}`)
}

function normalizeLanguage(language?: string): string {
  if (!language || language === 'auto') {
    return DEFAULT_LANGUAGE
  }

  return String(language).replace(/-/g, '_')
}

function toBuffer(data: ArrayBuffer | ArrayBufferView | Buffer): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }

  throw new TypeError('audioData must be an ArrayBuffer, Buffer, or typed array')
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback

  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }

  return normalized
}

function slicePcmData(data: Buffer, options: SliceOptions): Buffer {
  const { sampleRate, channels, bitsPerSample, offset, duration } = options
  const bytesPerFrame = channels * (bitsPerSample / 8)

  if (offset == null && duration == null) {
    return data
  }

  const offsetMs = offset ?? 0
  const durationMs = duration ?? null

  if (offsetMs < 0) {
    throw new RangeError('offset must be greater than or equal to 0')
  }

  if (durationMs != null && durationMs < 0) {
    throw new RangeError('duration must be greater than or equal to 0')
  }

  const startFrame = Math.floor((offsetMs / 1000) * sampleRate)
  const start = startFrame * bytesPerFrame
  const clampedStart = Math.min(start, data.length)
  const end = durationMs == null
    ? data.length
    : Math.min(data.length, start + Math.floor((durationMs / 1000) * sampleRate) * bytesPerFrame)

  return data.subarray(clampedStart, Math.max(Math.min(end, data.length), clampedStart))
}

function makeAbortedResult(language: string): TranscribeResult {
  return {
    language,
    result: '',
    segments: [],
    isAborted: true,
  }
}

function parseHelperJson<T>(stdout: string, stderr: string): T {
  const payload = stdout.trim()

  if (!payload) {
    throw new Error(stderr.trim() || 'Native helper produced no JSON output')
  }

  return JSON.parse(payload) as T
}

function rejectHelperError(reject: (reason?: unknown) => void, stderr: string, code: number | null): void {
  try {
    const parsed = stderr.trim() ? JSON.parse(stderr.trim()) as { error?: string } : null
    reject(new Error(parsed?.error || stderr.trim() || `Native helper exited with code ${code}`))
  } catch {
    reject(new Error(stderr.trim() || `Native helper exited with code ${code}`))
  }
}

function runHelper<T>(command: string, args: string[] = [], options: HelperOptions = {}): Promise<T> {
  const helper = ensureHelper(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const child = spawn(helper, [command, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      reject(error)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)

      if (code === 0) {
        try {
          resolve(parseHelperJson<T>(stdout, stderr))
        } catch (error) {
          reject(error)
        }
        return
      }

      rejectHelperError(reject, stderr, code)
    })

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (!settled) {
          child.kill('SIGTERM')
          reject(new Error(`Native helper timed out after ${timeoutMs}ms`))
          settled = true
        }
      }, timeoutMs)
    }
  })
}

function runTranscription(filePath: string, options: TranscriptionRunOptions, cleanupPath?: string): TranscriptionRequest {
  const helper = ensureHelper(options)
  const language = normalizeLanguage(options.language)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args = ['transcribe', '--file', filePath, '--language', language]

  if (options.prepare === false || options.autoPrepare === false) {
    args.push('--no-prepare')
  }

  const child = spawn(helper, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let stopped = false
  let done = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  const stopWaiters: Array<() => void> = []

  const cleanup = (): void => {
    if (timeout) clearTimeout(timeout)
    if (cleanupPath) {
      fs.rm(cleanupPath, { force: true }, () => {})
    }
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })

  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const promise = new Promise<TranscribeResult>((resolve, reject) => {
    child.on('error', (error) => {
      done = true
      cleanup()
      for (const waiter of stopWaiters.splice(0)) waiter()
      reject(error)
    })

    child.on('close', (code) => {
      done = true
      cleanup()
      for (const waiter of stopWaiters.splice(0)) waiter()

      if (stopped) {
        resolve(makeAbortedResult(language))
        return
      }

      if (code === 0) {
        try {
          resolve(parseHelperJson<TranscribeResult>(stdout, stderr))
        } catch (error) {
          reject(error)
        }
        return
      }

      rejectHelperError(reject, stderr, code)
    })

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (!done) {
          child.kill('SIGTERM')
          reject(new Error(`Transcription timed out after ${timeoutMs}ms`))
          done = true
          cleanup()
        }
      }, timeoutMs)
    }
  })

  return {
    stop: () => {
      stopped = true

      if (done) {
        return Promise.resolve()
      }

      child.kill('SIGTERM')
      return new Promise((resolve) => {
        stopWaiters.push(resolve)
      })
    },
    promise,
  }
}

export class AppleSpeechContext {
  public gpu = false

  public reasonNoGPU = 'Apple SpeechAnalyzer does not expose a GPU toggle.'

  private readonly language: string

  private readonly sampleRate: number

  private readonly channels: number

  private readonly bitsPerSample: number

  private readonly prepareByDefault: boolean

  private readonly helperPath?: string

  private released = false

  constructor(options: NativeContextOptions = {}) {
    this.language = normalizeLanguage(options.language ?? options.locale ?? options.localeIdentifier)
    this.sampleRate = positiveInteger(options.sampleRate, 16000, 'sampleRate')
    this.channels = positiveInteger(options.channels, 1, 'channels')
    this.bitsPerSample = positiveInteger(options.bitsPerSample, 16, 'bitsPerSample')
    this.prepareByDefault = options.prepare !== false && options.autoPrepare !== false
    this.helperPath = options.helperPath
  }

  private assertActive(): void {
    if (this.released) {
      throw new Error('AppleSpeechContext has been released')
    }
  }

  async prepare(language = this.language): Promise<PrepareResult> {
    this.assertActive()
    return prepareAppleSpeech({ language, helperPath: this.helperPath })
  }

  async isAvailable(language = this.language): Promise<AvailabilityResult> {
    this.assertActive()
    return isAppleSpeechAvailable({ language, helperPath: this.helperPath })
  }

  transcribeData(audioData: ArrayBuffer | ArrayBufferView | Buffer, options: TranscribeOptions = {}): TranscriptionRequest {
    this.assertActive()

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
    const onNewSegments = typeof options.onNewSegments === 'function' ? options.onNewSegments : null
    const language = normalizeLanguage(options.language ?? this.language)
    const sampleRate = positiveInteger(options.sampleRate, this.sampleRate, 'sampleRate')
    const channels = positiveInteger(options.channels, this.channels, 'channels')
    const bitsPerSample = positiveInteger(options.bitsPerSample, this.bitsPerSample, 'bitsPerSample')
    const data = slicePcmData(toBuffer(audioData), {
      sampleRate,
      channels,
      bitsPerSample,
      offset: options.offset,
      duration: options.duration,
    })
    const tempPath = path.join(os.tmpdir(), `node-apple-speech-${process.pid}-${crypto.randomUUID()}.wav`)
    const wav = encodeWav(data, { sampleRate, channels, bitsPerSample })

    fs.writeFileSync(tempPath, wav)

    if (onProgress) {
      queueMicrotask(() => onProgress(0))
    }

    const request = runTranscription(tempPath, {
      ...options,
      language,
      prepare: options.prepare ?? this.prepareByDefault,
      autoPrepare: options.autoPrepare ?? this.prepareByDefault,
      helperPath: options.helperPath ?? this.helperPath,
    }, tempPath)

    return {
      stop: request.stop,
      promise: request.promise.then((result) => {
        if (onProgress && !result.isAborted) {
          onProgress(100)
        }

        if (onNewSegments && !result.isAborted) {
          onNewSegments({
            nNew: result.segments.length,
            totalNNew: result.segments.length,
            result: result.result,
            segments: result.segments,
          })
        }

        return result
      }),
    }
  }

  transcribeFile(filePath: string, options: TranscribeOptions = {}): TranscriptionRequest {
    this.assertActive()

    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('filePath must be a non-empty string')
    }

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
    const onNewSegments = typeof options.onNewSegments === 'function' ? options.onNewSegments : null
    const language = normalizeLanguage(options.language ?? this.language)

    if (onProgress) {
      queueMicrotask(() => onProgress(0))
    }

    const request = runTranscription(path.resolve(filePath), {
      ...options,
      language,
      prepare: options.prepare ?? this.prepareByDefault,
      autoPrepare: options.autoPrepare ?? this.prepareByDefault,
      helperPath: options.helperPath ?? this.helperPath,
    })

    return {
      stop: request.stop,
      promise: request.promise.then((result) => {
        if (onProgress && !result.isAborted) {
          onProgress(100)
        }

        if (onNewSegments && !result.isAborted) {
          onNewSegments({
            nNew: result.segments.length,
            totalNNew: result.segments.length,
            result: result.result,
            segments: result.segments,
          })
        }

        return result
      }),
    }
  }

  transcribe(filePath: string, options: TranscribeOptions = {}): TranscriptionRequest {
    return this.transcribeFile(filePath, options)
  }

  async release(): Promise<void> {
    this.released = true
  }

  getModelInfo(): object {
    return {
      backend: 'SpeechAnalyzer',
      language: this.language,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample,
      helperPath: this.helperPath || process.env.NODE_APPLE_SPEECH_HELPER_PATH || DEFAULT_HELPER_PATH,
      platform: 'darwin',
    }
  }
}

export const WhisperContext = AppleSpeechContext

export async function initAppleSpeech(options: NativeContextOptions = {}, _variant?: LibVariant): Promise<AppleSpeechContext> {
  ensureHelper(options)
  const context = new AppleSpeechContext(options)

  if (options.prepare === true || options.autoPrepare === true) {
    await context.prepare()
  }

  return context
}

export const initWhisper = initAppleSpeech

export async function isAppleSpeechAvailable(options: LanguageOptions = {}): Promise<AvailabilityResult> {
  const language = normalizeLanguage(options.language ?? options.locale ?? options.localeIdentifier)
  return runHelper<AvailabilityResult>('is-available', ['--language', language], options)
}

export async function prepareAppleSpeech(options: LanguageOptions = {}): Promise<PrepareResult> {
  const language = normalizeLanguage(options.language ?? options.locale ?? options.localeIdentifier)
  return runHelper<PrepareResult>('prepare', ['--language', language], options)
}

export async function getAppleSpeechVersion(options: HelperOptions = {}): Promise<VersionResult> {
  return runHelper<VersionResult>('version', [], options)
}

export async function loadAppleSpeechModule(): Promise<{ AppleSpeechContext: typeof AppleSpeechContext, WhisperContext: typeof AppleSpeechContext }> {
  ensureHelper()
  return {
    AppleSpeechContext,
    WhisperContext,
  }
}

export const loadWhisperModule = loadAppleSpeechModule

export function toggleNativeLog(_enable?: boolean): void {
  // Present for whisper.node shape compatibility. The Swift helper currently emits only JSON.
}

export function addNativeLogListener(_listener?: (level: string, text: string) => void): { remove: () => void } {
  return {
    remove() {},
  }
}

const defaultExport = {
  AppleSpeechContext,
  WhisperContext,
  addNativeLogListener,
  getAppleSpeechVersion,
  initAppleSpeech,
  initWhisper,
  isAppleSpeechAvailable,
  loadAppleSpeechModule,
  loadWhisperModule,
  prepareAppleSpeech,
  toggleNativeLog,
}

export default defaultExport
