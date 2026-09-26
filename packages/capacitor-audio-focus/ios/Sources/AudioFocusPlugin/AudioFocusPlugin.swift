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
