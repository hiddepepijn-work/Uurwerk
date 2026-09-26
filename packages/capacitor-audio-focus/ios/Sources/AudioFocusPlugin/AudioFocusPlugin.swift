import AVFoundation
import Capacitor
import Foundation

/// Takes the audio session while Uurwerk speaks, so music in another app pauses instead of
/// playing under the voice, and hands it back afterwards so that music can resume.
///
/// `.playback` without `.mixWithOthers` is what makes iOS interrupt the other app;
/// `.notifyOthersOnDeactivation` is what tells it that it may start again.
@objc(AudioFocusPlugin)
public class AudioFocusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioFocusPlugin"
    public let jsName = "AudioFocus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise)
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
}
