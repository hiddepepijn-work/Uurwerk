import AVFoundation
import Capacitor
import Foundation
import Speech
import WidgetKit

/// Uurwerk's only native code, in one plugin:
///
/// - Audio focus: takes the audio session while Uurwerk speaks, so music in another app
///   pauses instead of playing under the voice, and hands it back afterwards so that music
///   can resume. `.playback` without `.mixWithOthers` is what makes iOS interrupt the other
///   app; `.notifyOthersOnDeactivation` is what tells it that it may start again.
/// - Widget data: writes widget.json into the App Group the home-screen widgets read, and
///   asks WidgetKit to redraw them.
/// - Listening: Apple's speech recognition on the microphone for talking to Jarvis. Emits
///   the words as they come (speechPartial), the loudness for the orb (speechLevel), and
///   the sentence once Hidde stops talking (speechEnd, after a short silence).
@objc(AudioFocusPlugin)
public class AudioFocusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioFocusPlugin"
    public let jsName = "AudioFocus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidgetData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listenStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listenStop", returnType: CAPPluginReturnPromise)
    ]

    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var heard = ""
    private var lastLevelAt = Date.distantPast

    @objc func listenStart(_ call: CAPPluginCall) {
        let locale = call.getString("locale") ?? "nl-NL"
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.reject("Spraakherkenning staat uit voor Uurwerk (Instellingen → Uurwerk).")
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                guard granted else {
                    call.reject("De microfoon staat uit voor Uurwerk (Instellingen → Uurwerk).")
                    return
                }
                DispatchQueue.main.async {
                    do {
                        try self.beginListening(locale: locale)
                        call.resolve()
                    } catch {
                        call.reject("Kon niet luisteren: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    @objc func listenStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.finishListening()
            call.resolve()
        }
    }

    private func beginListening(locale: String) throws {
        endListening()
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
            throw NSError(domain: "Uurwerk", code: 1, userInfo: [NSLocalizedDescriptionKey: "Spraakherkenning is nu niet beschikbaar"])
        }

        // Recording without mixing: music in other apps pauses while Jarvis listens.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            request.append(buffer)
            self?.emitLevel(buffer)
        }
        engine.prepare()
        try engine.start()

        audioEngine = engine
        recognitionRequest = request
        heard = ""
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    self.heard = result.bestTranscription.formattedString
                    self.notifyListeners("speechPartial", data: ["text": self.heard])
                    self.armSilence(after: 1.3)
                    if result.isFinal { self.finishListening() }
                } else if error != nil {
                    self.finishListening()
                }
            }
        }
        // Nothing said at all: stop after a while rather than listening forever.
        armSilence(after: 8)
    }

    /// A pause after speaking ends the sentence.
    private func armSilence(after seconds: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.finishListening()
        }
    }

    private func finishListening() {
        guard audioEngine != nil else { return }
        let text = heard
        endListening()
        notifyListeners("speechEnd", data: ["text": text])
    }

    private func endListening() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        if let engine = audioEngine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Loudness 0…1 for the orb, about fifteen times a second.
    private func emitLevel(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        let now = Date()
        guard now.timeIntervalSince(lastLevelAt) > 0.066 else { return }
        lastLevelAt = now
        var sum: Float = 0
        for index in 0..<count { sum += samples[index] * samples[index] }
        let decibels = 20 * log10(max(sqrt(sum / Float(count)), 0.00001))
        let level = min(1, max(0, (decibels + 55) / 45))
        DispatchQueue.main.async {
            self.notifyListeners("speechLevel", data: ["level": level])
        }
    }

    @objc func take(_ call: CAPPluginCall) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true)
            call.resolve()
        } catch {
            call.reject("Could not take the audio session: \(error.localizedDescription)")
        }
    }

    @objc func release(_ call: CAPPluginCall) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setActive(false, options: .notifyOthersOnDeactivation)
            // Back to the web view's default, which mixes with other apps' audio.
            try session.setCategory(.ambient, mode: .default, options: [])
            call.resolve()
        } catch {
            call.reject("Could not release the audio session: \(error.localizedDescription)")
        }
    }

    @objc func setWidgetData(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else {
            call.reject("Missing json")
            return
        }
        guard
            let group = resolvedAppGroup(),
            let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else {
            let bundle = Bundle.main.bundleIdentifier ?? "?"
            let fromProfile = profileAppGroups().joined(separator: ", ")
            call.reject("Widget: geen gedeelde map. Bundle \(bundle), profiel-groepen [\(fromProfile)]")
            return
        }
        do {
            try Data(json.utf8).write(to: folder.appendingPathComponent("widget.json"), options: .atomic)
            WidgetCenter.shared.reloadAllTimelines()
            call.resolve()
        } catch {
            call.reject("Could not write the widget data: \(error.localizedDescription)")
        }
    }
}

/// The App Group this build may use. SideStore re-signs with your own Apple ID and renames
/// identifiers to make them unique (nl.hiddepepijn.uurwerk.<team> and the group likewise),
/// so the name in the source is only a starting point. The authoritative list is in the
/// provisioning profile SideStore embedded; after that, what the bundle id suggests; last,
/// the original name.
func resolvedAppGroup() -> String? {
    let base = "nl.hiddepepijn.uurwerk"
    var candidates = profileAppGroups()
    if let bundle = Bundle.main.bundleIdentifier, bundle.hasPrefix(base + ".") {
        let rest = bundle.dropFirst(base.count + 1).split(separator: ".").map(String.init).filter { $0 != "widget" }
        if let team = rest.first {
            candidates.append("group.\(base).\(team)")
            candidates.append("group.\(base)")
        }
    }
    candidates.append("group.\(base)")
    return candidates.first { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil }
}

/// com.apple.security.application-groups from embedded.mobileprovision (a signed plist).
func profileAppGroups() -> [String] {
    guard
        let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
        let data = try? Data(contentsOf: url),
        let text = String(data: data, encoding: .isoLatin1),
        let start = text.range(of: "<?xml"),
        let end = text.range(of: "</plist>"),
        let plist = try? PropertyListSerialization.propertyList(
            from: Data(String(text[start.lowerBound..<end.upperBound]).utf8), format: nil
        ) as? [String: Any],
        let entitlements = plist["Entitlements"] as? [String: Any],
        let groups = entitlements["com.apple.security.application-groups"] as? [String]
    else { return [] }
    return groups
}
