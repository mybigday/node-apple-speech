export interface WavFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export interface DecodedWav extends WavFormat {
  data: Buffer
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
}

export function encodeWav(pcmData: ArrayBuffer | ArrayBufferView | Buffer, options: Partial<WavFormat> = {}): Buffer {
  const sampleRate = options.sampleRate ?? 16000
  const channels = options.channels ?? 1
  const bitsPerSample = options.bitsPerSample ?? 16
  const data = Buffer.from(pcmData as Buffer)

  assertPositiveInteger(sampleRate, 'sampleRate')
  assertPositiveInteger(channels, 'channels')
  assertPositiveInteger(bitsPerSample, 'bitsPerSample')

  if (bitsPerSample !== 16) {
    throw new TypeError('Only 16-bit PCM data is supported by transcribeData')
  }

  const bytesPerSample = bitsPerSample / 8
  const blockAlign = channels * bytesPerSample

  if (data.length % blockAlign !== 0) {
    throw new RangeError(`PCM data length must be aligned to ${blockAlign} bytes`)
  }

  const byteRate = sampleRate * blockAlign
  const output = Buffer.alloc(44 + data.length)

  output.write('RIFF', 0)
  output.writeUInt32LE(36 + data.length, 4)
  output.write('WAVE', 8)
  output.write('fmt ', 12)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(channels, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(byteRate, 28)
  output.writeUInt16LE(blockAlign, 32)
  output.writeUInt16LE(bitsPerSample, 34)
  output.write('data', 36)
  output.writeUInt32LE(data.length, 40)
  data.copy(output, 44)

  return output
}

export function decodeWav(input: ArrayBuffer | ArrayBufferView | Buffer): DecodedWav {
  const data = Buffer.from(input as Buffer)

  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a RIFF/WAVE file')
  }

  let offset = 12
  let format: WavFormat | null = null
  let pcm: Buffer | null = null

  while (offset + 8 <= data.length) {
    const chunkId = data.toString('ascii', offset, offset + 4)
    const chunkSize = data.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkSize

    if (chunkEnd > data.length) {
      throw new Error(`Invalid WAV chunk size for ${chunkId}`)
    }

    if (chunkId === 'fmt ') {
      const audioFormat = data.readUInt16LE(chunkStart)
      if (audioFormat !== 1) {
        throw new Error(`Only PCM WAV files are supported, got format ${audioFormat}`)
      }

      format = {
        sampleRate: data.readUInt32LE(chunkStart + 4),
        channels: data.readUInt16LE(chunkStart + 2),
        bitsPerSample: data.readUInt16LE(chunkStart + 14),
      }
    } else if (chunkId === 'data') {
      pcm = Buffer.from(data.subarray(chunkStart, chunkEnd))
    }

    offset = chunkEnd + (chunkSize % 2)
  }

  if (!format) {
    throw new Error('Missing WAV fmt chunk')
  }

  if (!pcm) {
    throw new Error('Missing WAV data chunk')
  }

  if (format.bitsPerSample !== 16) {
    throw new Error(`Only 16-bit PCM WAV files are supported, got ${format.bitsPerSample}`)
  }

  return {
    ...format,
    data: pcm,
  }
}
