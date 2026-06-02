import AVFoundation
import CoreMedia
import Foundation
import Speech

struct Segment: Codable {
  let text: String
  let t0: Double
  let t1: Double
}

struct TranscriptionOutput: Codable {
  let language: String
  let result: String
  let segments: [Segment]
  let duration: Double
  let isAborted: Bool
}

struct AvailabilityOutput: Codable {
  let available: Bool
  let language: String
}

struct PrepareOutput: Codable {
  let prepared: Bool
  let language: String
}

struct VersionOutput: Codable {
  let backend: String
  let minimumMacOS: String
}

struct ErrorOutput: Codable {
  let error: String
}

enum HelperError: LocalizedError {
  case missingArgument(String)
  case unsupportedCommand(String)
  case unsupportedPlatform
  case unsupportedLocale(String)
  case invalidAudio(String)
  case assetUnsupported(String)
  case unknownAssetStatus

  var errorDescription: String? {
    switch self {
    case .missingArgument(let name):
      return "Missing required argument: \(name)"
    case .unsupportedCommand(let command):
      return "Unsupported command: \(command)"
    case .unsupportedPlatform:
      return "Apple SpeechAnalyzer requires macOS 26.0 or newer."
    case .unsupportedLocale(let language):
      return "Locale not supported: \(language)"
    case .invalidAudio(let path):
      return "Invalid audio file: \(path)"
    case .assetUnsupported(let language):
      return "Assets not supported for locale: \(language)"
    case .unknownAssetStatus:
      return "Unknown asset inventory status."
    }
  }
}

@available(macOS 26.0, *)
final class AppleSpeechEngine {
  static func createTranscriber(for locale: Locale) -> SpeechTranscriber {
    let preset = SpeechTranscriber.Preset.timeIndexedTranscriptionWithAlternatives

    return SpeechTranscriber(
      locale: locale,
      transcriptionOptions: preset.transcriptionOptions,
      reportingOptions: preset.reportingOptions.subtracting([.alternativeTranscriptions]),
      attributeOptions: preset.attributeOptions
    )
  }

  static func supportedLocale(for language: String) async throws -> Locale {
    let locale = Locale(identifier: language)

    guard let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
      throw HelperError.unsupportedLocale(language)
    }

    return supportedLocale
  }

  static func isAvailable(language: String) async -> AvailabilityOutput {
    guard SpeechTranscriber.isAvailable,
          let supportedLocale = try? await supportedLocale(for: language)
    else {
      return AvailabilityOutput(available: false, language: language)
    }

    return AvailabilityOutput(available: true, language: supportedLocale.identifier)
  }

  @discardableResult
  static func prepare(language: String) async throws -> PrepareOutput {
    let supportedLocale = try await supportedLocale(for: language)
    let transcriber = createTranscriber(for: supportedLocale)
    let status = await AssetInventory.status(forModules: [transcriber])

    switch status {
    case .installed:
      return PrepareOutput(prepared: true, language: supportedLocale.identifier)
    case .supported, .downloading:
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }
      return PrepareOutput(prepared: true, language: supportedLocale.identifier)
    case .unsupported:
      throw HelperError.assetUnsupported(supportedLocale.identifier)
    @unknown default:
      throw HelperError.unknownAssetStatus
    }
  }

  static func transcribe(fileURL: URL, language: String, autoPrepare: Bool) async throws -> TranscriptionOutput {
    let supportedLocale = try await supportedLocale(for: language)

    if autoPrepare {
      _ = try await prepare(language: supportedLocale.identifier)
    }

    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      throw HelperError.invalidAudio(fileURL.path)
    }

    let audioFile: AVAudioFile
    do {
      audioFile = try AVAudioFile(forReading: fileURL)
    } catch {
      throw HelperError.invalidAudio(fileURL.path)
    }

    let transcriber = createTranscriber(for: supportedLocale)
    let analyzer = SpeechAnalyzer(modules: [transcriber])

    let resultTask = Task { () throws -> [Segment] in
      var segments: [Segment] = []

      for try await result in transcriber.results {
        guard result.isFinal else {
          continue
        }

        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
          continue
        }

        let start = CMTimeGetSeconds(result.range.start)
        let end = CMTimeGetSeconds(CMTimeRangeGetEnd(result.range))
        segments.append(Segment(text: text, t0: start * 1000.0, t1: end * 1000.0))
      }

      return segments
    }

    let lastSampleTime = try await analyzer.analyzeSequence(from: audioFile)

    if let lastSampleTime {
      try await analyzer.finalizeAndFinish(through: lastSampleTime)
    } else {
      await analyzer.cancelAndFinishNow()
    }

    let segments = try await resultTask.value
    let text = segments.map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    let duration = lastSampleTime.map { CMTimeGetSeconds($0) } ?? 0.0

    return TranscriptionOutput(
      language: supportedLocale.identifier,
      result: text,
      segments: segments,
      duration: duration,
      isAborted: false
    )
  }
}

struct ParsedArguments {
  let command: String
  let options: [String: String]
  let flags: Set<String>
}

func parseArguments(_ arguments: [String]) throws -> ParsedArguments {
  guard let command = arguments.first else {
    throw HelperError.missingArgument("command")
  }

  var options: [String: String] = [:]
  var flags = Set<String>()
  var index = 1

  while index < arguments.count {
    let argument = arguments[index]

    if argument.hasPrefix("--") {
      let name = String(argument.dropFirst(2))

      if index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") {
        options[name] = arguments[index + 1]
        index += 2
      } else {
        flags.insert(name)
        index += 1
      }
    } else {
      index += 1
    }
  }

  return ParsedArguments(command: command, options: options, flags: flags)
}

func writeJSON<T: Encodable>(_ value: T, to handle: FileHandle = .standardOutput) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  let data = try encoder.encode(value)
  handle.write(data)
  handle.write(Data([0x0A]))
}

func run(_ parsed: ParsedArguments) async throws {
  let language = parsed.options["language"] ?? "en_US"

  switch parsed.command {
  case "version":
    try writeJSON(VersionOutput(backend: "SpeechAnalyzer", minimumMacOS: "26.0"))
  case "is-available":
    if #available(macOS 26.0, *) {
      try await writeJSON(AppleSpeechEngine.isAvailable(language: language))
    } else {
      try writeJSON(AvailabilityOutput(available: false, language: language))
    }
  case "prepare":
    if #available(macOS 26.0, *) {
      try await writeJSON(AppleSpeechEngine.prepare(language: language))
    } else {
      throw HelperError.unsupportedPlatform
    }
  case "transcribe":
    guard let file = parsed.options["file"] else {
      throw HelperError.missingArgument("file")
    }

    if #available(macOS 26.0, *) {
      let autoPrepare = !parsed.flags.contains("no-prepare")
      let fileURL = URL(fileURLWithPath: file)
      try await writeJSON(AppleSpeechEngine.transcribe(fileURL: fileURL, language: language, autoPrepare: autoPrepare))
    } else {
      throw HelperError.unsupportedPlatform
    }
  default:
    throw HelperError.unsupportedCommand(parsed.command)
  }
}

@main
struct AppleSpeechHelper {
  static func main() async {
    do {
      let parsed = try parseArguments(Array(CommandLine.arguments.dropFirst()))
      try await run(parsed)
    } catch {
      let message = error.localizedDescription
      try? writeJSON(ErrorOutput(error: message), to: .standardError)
      Foundation.exit(1)
    }
  }
}
