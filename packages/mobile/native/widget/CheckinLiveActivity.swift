// The Live Activity's look: lock screen and Dynamic Island. The data and the buttons' actions
// are in CheckinLive.swift.
//
//   before the block   "Om 14:00" and the time until it starts
//   during             a countdown to the end, ✓ Klaar, ▶ Bezig, ✗ Nog niet
//   after (stale)      "Gelukt?" with ✓ Gelukt and ✗ Nog niet af
//
// ✗ is a link into the app (uurwerk://checkin?…): on an important task Jarvis then asks why.

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct CheckinLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CheckinAttributes.self) { context in
            CheckinLockView(state: context.state, stale: context.isStale)
                .padding(16)
                .activityBackgroundTint(Palette.background.opacity(0.92))
                .activitySystemActionForegroundColor(Palette.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.state.title)
                        .font(.headline)
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    CheckinClock(state: context.state, stale: context.isStale)
                        .font(.headline)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    CheckinButtons(state: context.state, stale: context.isStale)
                }
            } compactLeading: {
                Image(systemName: context.isStale ? "questionmark.circle.fill" : "checkmark.circle")
                    .foregroundStyle(Palette.accent)
            } compactTrailing: {
                CheckinClock(state: context.state, stale: context.isStale)
                    .frame(maxWidth: 52)
            } minimal: {
                Image(systemName: "checkmark.circle").foregroundStyle(Palette.accent)
            }
            .keylineTint(Palette.accent)
        }
    }
}

private func clock(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "nl_NL")
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
}

/// Counts down to the start before the block, to the end during it; "klaar?" afterwards.
@available(iOS 17.0, *)
struct CheckinClock: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool

    var body: some View {
        let now = Date()
        if stale || now >= state.end {
            Text("klaar?").foregroundStyle(Palette.now)
        } else if now < state.start {
            Text(timerInterval: now...state.start, countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(Palette.faint)
        } else {
            Text(timerInterval: now...state.end, countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(Palette.accent)
        }
    }
}

@available(iOS 17.0, *)
struct CheckinLockView: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool

    var body: some View {
        let now = Date()
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(heading(now: now))
                        .font(.caption)
                        .foregroundStyle(stale ? Palette.now : Palette.faint)
                    Text(state.title)
                        .font(.headline)
                        .foregroundStyle(Palette.text)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                CheckinClock(state: state, stale: stale)
                    .font(.title3.weight(.semibold))
            }
            if !stale && now >= state.start && now < state.end {
                ProgressView(timerInterval: state.start...state.end, countsDown: false) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .tint(Palette.accent)
            }
            CheckinButtons(state: state, stale: stale)
        }
    }

    private func heading(now: Date) -> String {
        let span = "\(clock(state.start))–\(clock(state.end))"
        let what = state.important ? " · belangrijk" : ""
        if stale || now >= state.end { return "Gelukt?\(what)" }
        if now < state.start { return "Straks \(span)\(what)" }
        return (state.busy ? "Bezig · \(span)" : "Nu gepland · \(span)") + what
    }
}

@available(iOS 17.0, *)
struct CheckinButtons: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool

    var body: some View {
        HStack(spacing: 8) {
            Button(intent: CheckinDoneIntent(taskId: state.taskId)) {
                pill(stale ? "Gelukt" : "Klaar", icon: "checkmark", color: Palette.accent)
            }
            .buttonStyle(.plain)
            if !stale && !state.busy {
                Button(intent: CheckinBusyIntent(taskId: state.taskId)) {
                    pill("Bezig", icon: "play.fill", color: Color(red: 0.416, green: 0.655, blue: 1.0))
                }
                .buttonStyle(.plain)
            }
            Link(destination: notYetLink) {
                pill(stale ? "Nog niet af" : "Nog niet", icon: "xmark", color: Palette.now)
            }
        }
    }

    private var notYetLink: URL {
        var parts = URLComponents()
        parts.scheme = "uurwerk"
        parts.host = "checkin"
        parts.queryItems = [
            URLQueryItem(name: "task", value: state.taskId),
            URLQueryItem(name: "stage", value: stale ? "end" : "midway"),
            URLQueryItem(name: "important", value: state.important ? "1" : "0"),
            URLQueryItem(name: "title", value: state.title)
        ]
        return parts.url ?? URL(string: "uurwerk://today")!
    }

    private func pill(_ label: String, icon: String, color: Color) -> some View {
        Label(label, systemImage: icon)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(color.opacity(0.16), in: Capsule())
    }
}
