import AudioToolbox
import AVFoundation
import Capacitor
import Foundation
import Speech
import UIKit
import UserNotifications
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
        CAPPluginMethod(name: "listenStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveCheckin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveTake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notificationButtons", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cue", returnType: CAPPluginReturnPromise)
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

    /// A live Jarvis call runs in the web view, which iOS pauses the moment the screen locks.
    /// With the phone in the car holder, the screen stays on for as long as the call lasts.
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    /// A live Jarvis call: record and play as a conversation. With AirPods (or any Bluetooth
    /// headset) connected, their microphone and speakers are used; otherwise the loudspeaker.
    /// The web view on its own picked the iPhone microphone even with AirPods in.
    @objc func voiceSession(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                if on {
                    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
                    try session.setActive(true)
                    if let headset = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
                        try session.setPreferredInput(headset)
                    }
                } else {
                    try session.setActive(false, options: .notifyOthersOnDeactivation)
                    try session.setCategory(.ambient, mode: .default, options: [])
                }
                call.resolve(["input": session.currentRoute.inputs.first?.portName ?? ""])
            } catch {
                call.reject("Kon de audio voor het gesprek niet instellen: \(error.localizedDescription)")
            }
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

    // The Live Activity lives in the app target (native/widget/CheckinLive.swift, shared with the
    // widget), not in this module: its intents must run in the app. This only hands over the
    // queue and collects what was pressed, through the same UserDefaults keys.
    @objc func liveCheckin(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else {
            call.reject("Missing json")
            return
        }
        UserDefaults.standard.set(json, forKey: "uurwerk.live.queue")
        if let live = NSClassFromString("UurwerkLiveCheckin") as? NSObject.Type {
            _ = live.perform(NSSelectorFromString("sync"))
        }
        call.resolve()
    }

    @objc func liveTake(_ call: CAPPluginCall) {
        let answers = UserDefaults.standard.array(forKey: "uurwerk.live.answers") ?? []
        UserDefaults.standard.removeObject(forKey: "uurwerk.live.answers")
        call.resolve(["answers": answers])
    }

    /// Start, stop and done: a tap always, and the sound as a system sound — which iOS keeps
    /// quiet when the ring/silent switch is on silent, and plays at the ringer's volume otherwise.
    @objc func cue(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        DispatchQueue.main.async {
            switch name {
            case "done": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "start", "begins": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "soon15": UINotificationFeedbackGenerator().notificationOccurred(.warning)
            default: UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            }
            if let sound = self.cueSound(name) { AudioServicesPlaySystemSound(sound) }
            call.resolve()
        }
    }

    private var cueSounds: [String: SystemSoundID] = [:]

    /// The .caf the iOS build made from scripts/cue-sounds.ts, in the bundle's web folder.
    private func cueSound(_ name: String) -> SystemSoundID? {
        if let sound = cueSounds[name] { return sound }
        guard let url = Bundle.main.url(forResource: "cue-\(name)", withExtension: "caf", subdirectory: "public/sounds") else { return nil }
        var sound: SystemSoundID = 0
        guard AudioServicesCreateSystemSoundID(url as CFURL, &sound) == kAudioServicesNoError else { return nil }
        cueSounds[name] = sound
        return sound
    }

    // The check-in buttons with an icon each. Capacitor registers them without; this replaces
    // those two categories with the same identifiers and action ids, so its listener still gets
    // every answer.
    @objc func notificationButtons(_ call: CAPPluginCall) {
        func action(_ id: String, _ title: String, _ symbol: String) -> UNNotificationAction {
            if #available(iOS 15.0, *) {
                return UNNotificationAction(identifier: id, title: title, options: [.foreground], icon: UNNotificationActionIcon(systemImageName: symbol))
            }
            return UNNotificationAction(identifier: id, title: title, options: [.foreground])
        }
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var categories = existing.filter { $0.identifier != "checkin-midway" && $0.identifier != "checkin-end" }
            categories.insert(UNNotificationCategory(identifier: "checkin-midway", actions: [action("busy", "Ja, bezig", "play.fill"), action("notyet", "Nog niet", "xmark")], intentIdentifiers: [], options: []))
            categories.insert(UNNotificationCategory(identifier: "checkin-end", actions: [action("done", "Gelukt", "checkmark"), action("notdone", "Nog niet af", "xmark")], intentIdentifiers: [], options: []))
            center.setNotificationCategories(categories)
            call.resolve()
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
