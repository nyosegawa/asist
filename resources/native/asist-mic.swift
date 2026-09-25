import AVFoundation
import Foundation

// asist-mic: the helper that captures the microphone through macOS voice processing (AEC, NS, AGC).
//
// Chromium's getUserMedia cannot use Apple's VoiceProcessingIO, so the capture happens through
// AVAudioEngine and the raw stream, mono float32 at 48 kHz in little endian, goes to stdout. Apple's AEC
// uses the whole system's output as its reference signal, so the echo of the TTS that Chromium plays is
// cancelled here as well. Logs go to stderr.
//
// Exit codes:
//   0 = a normal exit, where EOF on stdin is the parent asking it to stop
//   2 = the audio configuration changed, for instance the device was switched, and the parent restarts it
//   3 = voice processing cannot be enabled
//   4 = there is no input device, or the engine failed to start
//
// Build it with scripts/build-native-mic.sh, which runs swiftc.

func log(_ message: String) {
  FileHandle.standardError.write(Data(("asist-mic: " + message + "\n").utf8))
}

// A closed stdout, which means the parent died, is noticed as a failed write rather than a crash.
signal(SIGPIPE, SIG_IGN)

// The parent asks it to stop with EOF on stdin, which does not depend on a race with a kill.
Thread.detachNewThread {
  while readLine(strippingNewline: false) != nil {}
  exit(0)
}

let engine = AVAudioEngine()
let input = engine.inputNode

do {
  try input.setVoiceProcessingEnabled(true)
} catch {
  log("voice processing unavailable: \(error.localizedDescription)")
  exit(3)
}

// Ducking the TTS playback volume is SpeechPlayer's job in the app. Being ducked twice makes the volume
// unstable, so voice processing's own ducking is turned off.
if #available(macOS 14.0, *) {
  input.voiceProcessingOtherAudioDuckingConfiguration =
    AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
      enableAdvancedDucking: false,
      duckingLevel: .min
    )
}

// The format is only settled once voice processing is enabled.
let hwFormat = input.outputFormat(forBus: 0)
guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
  log("no usable input device")
  exit(4)
}

guard
  let outFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 48_000,
    channels: 1,
    interleaved: false
  ),
  let converter = AVAudioConverter(from: hwFormat, to: outFormat)
else {
  log("audio converter unavailable for \(hwFormat.sampleRate)Hz")
  exit(4)
}

// A voice processing input node sometimes reports more channels than the hardware has, which is one; 9
// were measured. Averaging them down would thin the voice to 1/N and it would no longer reach the VAD, so
// channel 0, the main microphone, is taken on its own.
if hwFormat.channelCount > 1 {
  converter.channelMap = [0]
}

// A device switch or a sample rate change is not followed here; the process is restarted instead.
NotificationCenter.default.addObserver(
  forName: .AVAudioEngineConfigurationChange,
  object: engine,
  queue: nil
) { _ in
  log("audio configuration changed")
  exit(2)
}

func writeAll(_ data: Data) {
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    var offset = 0
    while offset < raw.count {
      let written = write(1, raw.baseAddress!.advanced(by: offset), raw.count - offset)
      if written <= 0 {
        // The parent stopped reading.
        exit(0)
      }
      offset += written
    }
  }
}

// The peak of each channel over the first two seconds is reported once, which is what tells you which
// channel actually carries the voice and whether taking channel 0 is right.
var diagnosticFramesLeft = 96_000
var diagnosticPeaks = [Float](repeating: 0, count: Int(hwFormat.channelCount))
var diagnosticReported = false

input.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { buffer, _ in
  if !diagnosticReported, let channels = buffer.floatChannelData {
    for channel in 0..<Int(buffer.format.channelCount) {
      var peak: Float = 0
      let samples = channels[channel]
      for index in 0..<Int(buffer.frameLength) {
        peak = max(peak, abs(samples[index]))
      }
      if channel < diagnosticPeaks.count {
        diagnosticPeaks[channel] = max(diagnosticPeaks[channel], peak)
      }
    }
    diagnosticFramesLeft -= Int(buffer.frameLength)
    if diagnosticFramesLeft <= 0 {
      diagnosticReported = true
      let formatted = diagnosticPeaks.map { String(format: "%.4f", $0) }.joined(separator: ",")
      log("channel peaks (first 2s): [\(formatted)]")
    }
  }
  let ratio = outFormat.sampleRate / hwFormat.sampleRate
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
  guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
  var consumed = false
  var conversionError: NSError?
  converter.convert(to: out, error: &conversionError) { _, status in
    if consumed {
      status.pointee = .noDataNow
      return nil
    }
    consumed = true
    status.pointee = .haveData
    return buffer
  }
  if conversionError != nil { return }
  guard out.frameLength > 0, let channel = out.floatChannelData?[0] else { return }
  writeAll(Data(bytes: channel, count: Int(out.frameLength) * MemoryLayout<Float>.size))
}

engine.prepare()
do {
  try engine.start()
} catch {
  log("engine start failed: \(error.localizedDescription)")
  exit(4)
}

log("ready input=\(hwFormat.sampleRate)Hz ch=\(hwFormat.channelCount) → 48000Hz mono")
RunLoop.main.run()
