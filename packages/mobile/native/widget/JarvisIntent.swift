import AppIntents
import UIKit

/// "Hé Siri, Jarvis": opens the app straight into a conversation with Jarvis.
///
/// It goes through uurwerk://jarvis, the same link the widget button uses, so the app has one
/// way in. In Shortcuts it shows up as "Praat met Jarvis"; a shortcut named just "Jarvis" with
/// this action is what makes Siri react to the one word. Also fits on the Action Button.
/// App only (add-widget.rb): the widget has no business opening the app's conversations.
@available(iOS 17.0, *)
struct OpenJarvisIntent: AppIntent {
    static var title: LocalizedStringResource = "Praat met Jarvis"
    static var description = IntentDescription("Opent Uurwerk en begint een gesprek met Jarvis.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: "uurwerk://jarvis") {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}

/// Siri phrases that work without making a shortcut first. Apple requires the app's name in
/// each one; the shortcut named "Jarvis" is the way around that.
@available(iOS 17.0, *)
struct UurwerkShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenJarvisIntent(),
            phrases: [
                "Jarvis in \(.applicationName)",
                "\(.applicationName) Jarvis",
                "Praat met Jarvis in \(.applicationName)"
            ],
            shortTitle: "Jarvis",
            systemImageName: "waveform"
        )
    }
}
