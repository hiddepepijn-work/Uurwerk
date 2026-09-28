// The Live Activity's data and buttons: compiled into both the app and the widget extension.
//
// The app (live.ts) hands over a queue of today's planned tasks; LiveCheckin.refresh picks the
// one of this moment and shows it. ✓ Klaar and ▶ Bezig are LiveActivityIntents: iOS runs them
// in the app's process, also while the app is closed, so they can mark the task, tell the
// server and move on to the next task without opening anything. What was pressed is also
// kept for the app (liveTake), which applies it to its own copy of the data when it runs.
//
// In the widget extension only the types are needed; everything that acts is left out there
// (WIDGET_EXTENSION, set in add-widget.rb), because an extension may not start activities.

import ActivityKit
import AppIntents
import Foundation

@available(iOS 16.1, *)
struct CheckinAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var taskId: String
        var title: String
        var start: Date
        var end: Date
        var important: Bool
        var busy: Bool
        var project: String?
        /// The task planned after this one, for "daarna …".
        var next: String? = nil
    }
}

@available(iOS 17.0, *)
struct CheckinDoneIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Taak klaar"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Taak")
    var taskId: String

    init() {}
    init(taskId: String) { self.taskId = taskId }

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        LiveStore.record("done", taskId: taskId)
        await LiveServer.complete(taskId)
        await LiveCheckin.refresh()
        #endif
        return .result()
    }
}

@available(iOS 17.0, *)
struct CheckinBusyIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Ben bezig"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Taak")
    var taskId: String

    init() {}
    init(taskId: String) { self.taskId = taskId }

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        LiveStore.record("busy", taskId: taskId)
        await LiveCheckin.refresh()
        #endif
        return .result()
    }
}

#if !WIDGET_EXTENSION

/// One planned task, as live.ts writes it.
struct LiveBlock: Codable {
    let taskId: String
    let title: String
    let start: Double
    let end: Double
    let important: Bool
    let project: String?
    /// The timer runs on it (the app knows).
    let busy: Bool?
}

/// What the app handed over and what was pressed, in the app's own UserDefaults.
enum LiveStore {
    static let queueKey = "uurwerk.live.queue"
    static let answersKey = "uurwerk.live.answers"
    static var defaults: UserDefaults { .standard }

    static func setQueue(_ json: String) { defaults.set(json, forKey: queueKey) }

    static func queue() -> [LiveBlock] {
        guard let json = defaults.string(forKey: queueKey) else { return [] }
        return (try? JSONDecoder().decode([LiveBlock].self, from: Data(json.utf8))) ?? []
    }

    /// Pressed on the Live Activity: [{answer, taskId, at}], until the app takes them.
    static func answers() -> [[String: Any]] { defaults.array(forKey: answersKey) as? [[String: Any]] ?? [] }

    static func record(_ answer: String, taskId: String) {
        var list = answers()
        list.append(["answer": answer, "taskId": taskId, "at": Date().timeIntervalSince1970 * 1000])
        defaults.set(Array(list.suffix(50)), forKey: answersKey)
    }

    static func take() -> [[String: Any]] {
        let list = answers()
        defaults.removeObject(forKey: answersKey)
        return list
    }
}

/// Tells the server at once, so the laptop and Jarvis know without waiting for the phone.
/// The same stored pairing the app syncs with (Capacitor Preferences keeps it here).
enum LiveServer {
    static func complete(_ taskId: String) async {
        let defaults = UserDefaults.standard
        guard
            let base = defaults.string(forKey: "CapacitorStorage.serverUrl"), !base.isEmpty,
            let token = defaults.string(forKey: "CapacitorStorage.deviceToken"), !token.isEmpty,
            let url = URL(string: base + "/api/rpc/tasks/complete")
        else { return }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [taskId, true])
        _ = try? await URLSession.shared.data(for: request)
    }
}

/// Reached from the plugin by name (NSClassFromString), since the plugin lives in its own module.
@objc(UurwerkLiveCheckin)
final class LiveCheckin: NSObject {
    @objc static func sync() {
        guard #available(iOS 17.0, *) else { return }
        Task { await refresh() }
    }

    /// The task of this moment: the first one not answered with ✓ that is running, starts within
    /// half an hour, or ended less than half an hour ago (then it asks "gelukt?").
    @available(iOS 17.0, *)
    static func refresh() async {
        let now = Date().timeIntervalSince1970 * 1000
        let answers = LiveStore.answers()
        let done = Set(answers.filter { $0["answer"] as? String == "done" }.compactMap { $0["taskId"] as? String })
        let busy = Set(answers.filter { $0["answer"] as? String == "busy" }.compactMap { $0["taskId"] as? String })
        let queue = LiveStore.queue()
        let focus = queue.first { block in
            !done.contains(block.taskId) && block.end > now - 30 * 60_000 && block.start <= now + 30 * 60_000
        }
        let activities = Activity<CheckinAttributes>.activities

        guard let block = focus else {
            for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        let state = CheckinAttributes.ContentState(
            taskId: block.taskId,
            title: block.title,
            start: Date(timeIntervalSince1970: block.start / 1000),
            end: Date(timeIntervalSince1970: block.end / 1000),
            important: block.important,
            busy: busy.contains(block.taskId) || block.busy == true,
            project: block.project,
            next: queue.first(where: { $0.start >= block.end - 60_000 && $0.taskId != block.taskId && !done.contains($0.taskId) })?.title
        )
        // Stale at the end of the block: the view then turns into the "gelukt?" question.
        let content = ActivityContent(state: state, staleDate: state.end)

        if let current = activities.first(where: { $0.content.state.taskId == state.taskId && $0.content.state.start == state.start }) {
            if current.content.state != state { await current.update(content) }
            for other in activities where other.id != current.id { await other.end(nil, dismissalPolicy: .immediate) }
            return
        }
        for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        _ = try? Activity.request(attributes: CheckinAttributes(), content: content, pushType: nil)
    }
}

#endif
