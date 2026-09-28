// The Live Activity's look: lock screen and Dynamic Island, in the "Inkt" style (STIJL.md).
// The data and the buttons' actions are in CheckinLive.swift.
//
//   before the block   "Straks" chip, the ring empty, the time until it starts in the middle
//   during             "Nu bezig" / "Nu gepland", the ring fills as the block passes, a
//                      countdown to the end, then ✓ Klaar, ▶ Bezig, ✗ Nog niet
//   after (stale)      "Gelukt?" with ✓ Gelukt and ✗ Nog niet af
//
// ✗ is a link into the app (uurwerk://checkin?…): on an important task Jarvis then asks why.
//
// The ring is drawn from the time at render (a Live Activity has no timer-driven shape), so it
// moves on each update the app sends; the number inside is a live countdown (Text(timerInterval:)).

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct CheckinLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CheckinAttributes.self) { context in
            CheckinLockView(state: context.state, stale: context.isStale)
                .padding(14)
                .activityBackgroundTint(hexColor(0x0C0E12).opacity(0.82))
                .activitySystemActionForegroundColor(Palette.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    CheckinRing(state: context.state, stale: context.isStale, size: 42, lineWidth: 4)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    let phase = CheckinPhase(state: context.state, stale: context.isStale, now: Date())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(phase.chip(busy: context.state.busy).uppercased() + " · \(clock(context.state.start))–\(clock(context.state.end))")
                            .font(.system(size: 11, weight: .bold))
                            .tracking(0.5)
                            .foregroundStyle(phase.soft)
                            .lineLimit(1)
                        Text(context.state.title)
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                            .foregroundStyle(Palette.text)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    let phase = CheckinPhase(state: context.state, stale: context.isStale, now: Date())
                    if phase != .before {
                        CheckinButtons(state: context.state, stale: phase == .after, height: 34)
                            .padding(.horizontal, 4)
                            .padding(.top, 4)
                    }
                }
            } compactLeading: {
                CheckinMiniRing(state: context.state, stale: context.isStale)
            } compactTrailing: {
                CheckinClock(state: context.state, stale: context.isStale)
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .frame(maxWidth: 56)
            } minimal: {
                CheckinMiniRing(state: context.state, stale: context.isStale)
            }
            .keylineTint(context.state.busy ? Palette.busyText : Palette.accent)
        }
    }
}

private func clock(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "nl_NL")
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
}

/// Where the moment is relative to the block, and the colours and words that go with it.
@available(iOS 17.0, *)
enum CheckinPhase {
    case before, during, after

    init(state: CheckinAttributes.ContentState, stale: Bool, now: Date) {
        if now >= state.end {
            self = .after
        } else if now < state.start {
            self = .before
        } else {
            self = .during
        }
    }

    func chip(busy: Bool) -> String {
        switch self {
        case .before: return "Straks"
        case .during: return busy ? "Nu bezig" : "Nu gepland"
        case .after: return "Gelukt?"
        }
    }

    var icon: String {
        switch self {
        case .before: return "clock"
        case .during: return "checkmark.circle"
        case .after: return "questionmark.circle.fill"
        }
    }

    /// Chip background.
    var fill: Color {
        switch self {
        case .before: return Palette.tint("school")
        case .during: return Palette.accent
        case .after: return Palette.dangerFill
        }
    }

    /// Chip text.
    var ink: Color {
        switch self {
        case .before: return Palette.busyText
        case .during: return Palette.accentInk
        case .after: return Palette.dangerText
        }
    }

    /// The same colour for text on the dark background (Dynamic Island).
    var soft: Color {
        switch self {
        case .before: return Palette.busyText
        case .during: return Palette.accentSoft
        case .after: return Palette.dangerText
        }
    }
}

/// The colour of the ring and the clock: what the moment is, and whether the timer runs.
@available(iOS 17.0, *)
func checkinTone(_ phase: CheckinPhase, busy: Bool) -> Color {
    switch phase {
    case .before: return Palette.faint
    case .during: return busy ? Palette.busyText : Palette.accent
    case .after: return Palette.now
    }
}

/// Counts down to the start before the block, to the end during it; "klaar?" afterwards.
@available(iOS 17.0, *)
struct CheckinClock: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool

    var body: some View {
        let now = Date()
        if now >= state.end {
            Text("klaar?").foregroundStyle(Palette.dangerText)
        } else if now < state.start {
            Text(timerInterval: now...state.start, countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(Palette.dim)
        } else {
            Text(timerInterval: now...state.end, countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(state.busy ? Palette.busyText : Palette.accent)
        }
    }
}

/// The ring on the lock screen: how much of the block has passed, with the live countdown
/// (or "klaar?") in the middle.
@available(iOS 17.0, *)
struct CheckinRing: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool

    var size: CGFloat = 64
    var lineWidth: CGFloat = 6

    var body: some View {
        let now = Date()
        let phase = CheckinPhase(state: state, stale: stale, now: now)
        ZStack {
            Circle()
                .stroke(Palette.ringTrack, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: progress(phase: phase, now: now))
                .stroke(checkinTone(phase, busy: state.busy), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                switch phase {
                case .after:
                    Image(systemName: "questionmark")
                        .font(.system(size: size * 0.28, weight: .bold, design: .rounded))
                        .foregroundStyle(Palette.dangerText)
                case .before:
                    Text(timerInterval: now...state.start, countsDown: true)
                        .font(.system(size: size * 0.23, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Palette.text)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                        .frame(width: size - 2 * lineWidth - 6)
                case .during:
                    Text(timerInterval: now...state.end, countsDown: true)
                        .font(.system(size: size * 0.23, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Palette.text)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                        .frame(width: size - 2 * lineWidth - 6)
                }
                Text(caption(phase))
                    .font(.system(size: 8, weight: .bold))
                    .tracking(0.6)
                    .foregroundStyle(Palette.dim)
            }
        }
        .padding(lineWidth / 2)
        .frame(width: size, height: size)
    }

    /// 0 before, the part that has passed during, full after.
    private func progress(phase: CheckinPhase, now: Date) -> CGFloat {
        switch phase {
        case .before: return 0
        case .after: return 1
        case .during:
            let total = max(state.end.timeIntervalSince(state.start), 1)
            let passed = now.timeIntervalSince(state.start)
            // A sliver at the very start, so the ring shows it has begun.
            return CGFloat(min(max(passed / total, 0.02), 1))
        }
    }

    private func caption(_ phase: CheckinPhase) -> String {
        switch phase {
        case .before: return "OVER"
        case .during: return "NOG"
        case .after: return "KLAAR?"
        }
    }
}

@available(iOS 17.0, *)
struct CheckinMiniRing: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool

    var body: some View {
        let now = Date()
        let phase = CheckinPhase(state: state, stale: stale, now: now)
        ZStack {
            Circle().stroke(Palette.ringTrack, lineWidth: 3)
            Circle()
                .trim(from: 0, to: fraction(phase: phase, now: now))
                .stroke(checkinTone(phase, busy: state.busy), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: phase == .after ? "questionmark" : "checkmark")
                .font(.system(size: 8, weight: .heavy))
                .foregroundStyle(phase == .after ? Palette.dangerText : checkinTone(phase, busy: state.busy))
        }
        .frame(width: 20, height: 20)
    }

    private func fraction(phase: CheckinPhase, now: Date) -> CGFloat {
        switch phase {
        case .before: return 0
        case .after: return 1
        case .during:
            let total = max(state.end.timeIntervalSince(state.start), 1)
            return CGFloat(min(max(now.timeIntervalSince(state.start) / total, 0.05), 1))
        }
    }
}

@available(iOS 17.0, *)
struct CheckinLockView: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool

    var body: some View {
        let now = Date()
        let phase = CheckinPhase(state: state, stale: stale, now: now)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                CheckinRing(state: state, stale: stale)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(phase.chip(busy: state.busy).uppercased())
                            .font(.system(size: 11, weight: .bold))
                            .tracking(0.7)
                            .foregroundStyle(phase.ink)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(phase.fill, in: Capsule())
                            .lineLimit(1)
                            // Words cross-fade and numbers roll when iOS redraws: the only motion
                            // a Live Activity allows.
                            .contentTransition(.opacity)
                        Text("\(clock(state.start))–\(clock(state.end))")
                            .font(.system(size: 12, weight: .semibold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            .foregroundStyle(Palette.dim)
                            .lineLimit(1)
                    }
                    Text(state.title)
                        .font(.system(size: 19, weight: .bold, design: .rounded))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    if let detail {
                        Text(detail)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Palette.dim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            if phase != .before {
                CheckinButtons(state: state, stale: phase == .after, height: 40)
            }
        }
    }

    /// "Project · daarna BO afmaken", with "belangrijk" when it is; whichever parts there are.
    private var detail: String? {
        var parts: [String] = []
        if let project = state.project, !project.isEmpty { parts.append(project) }
        if state.important { parts.append("belangrijk") }
        if let next = state.next, !next.isEmpty { parts.append("daarna \(next)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

@available(iOS 17.0, *)
struct CheckinButtons: View {
    let state: CheckinAttributes.ContentState
    let stale: Bool
    var height: CGFloat = 52

    var body: some View {
        HStack(spacing: 8) {
            Button(intent: CheckinDoneIntent(taskId: state.taskId)) {
                pill(stale ? "Gelukt" : "Klaar", icon: "checkmark", fill: Palette.accent, ink: Palette.accentInk)
            }
            .buttonStyle(.plain)
            if !stale && !state.busy {
                Button(intent: CheckinBusyIntent(taskId: state.taskId)) {
                    pill("Bezig", icon: "play.fill", fill: Palette.busyFill, ink: Palette.busyText)
                }
                .buttonStyle(.plain)
            }
            Link(destination: notYetLink) {
                pill(stale ? "Nog niet af" : "Nog niet", icon: "xmark", fill: Palette.dangerFill, ink: Palette.dangerText)
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

    /// A full-width pill: solid fill, icon and word in the fill's ink.
    private func pill(_ label: String, icon: String, fill: Color, ink: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: height >= 50 ? 15 : 13, weight: .bold))
            Text(label)
                .font(.system(size: height >= 50 ? 16 : 14, weight: .bold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(fill, in: RoundedRectangle(cornerRadius: height >= 50 ? 16 : 14))
    }
}
