import AVFoundation
import Capacitor
import Foundation
import WidgetKit

/// Uurwerk's only native code, in one plugin:
///
/// - Audio focus: takes the audio session while Uurwerk speaks, so music in another app
///   pauses instead of playing under the voice, and hands it back afterwards so that music
///   can resume. `.playback` without `.mixWithOthers` is what makes iOS interrupt the other
///   app; `.notifyOthersOnDeactivation` is what tells it that it may start again.
/// - Widget data: writes widget.json into the App Group the home-screen widgets read, and
///   asks WidgetKit to redraw them.
@objc(AudioFocusPlugin)
public class AudioFocusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioFocusPlugin"
    public let jsName = "AudioFocus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidgetData", returnType: CAPPluginReturnPromise)
    ]

    private static let appGroup = "group.nl.hiddepepijn.uurwerk"

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
        guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else {
            call.reject("The App Group is not available: the app was installed without it")
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
