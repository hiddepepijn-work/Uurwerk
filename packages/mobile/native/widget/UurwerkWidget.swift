// Uurwerk's home-screen widgets.
//
//   Agenda (large)   the next four hours in the app's agenda look; ▲ ▼ shift the window by
//                    four hours, "nu" jumps back. Widgets cannot scroll — these buttons are
//                    what iOS allows instead (App Intents, iOS 17).
//   Snel (medium)    Timer, Jarvis, Taak, Afspraak: each opens the app on that action.
//
// The app writes widget.json into the shared App Group container after every change; the
// widget only reads it. No network, no token: it shows what the phone already knows.

import AppIntents
import SwiftUI
import WidgetKit

let appGroup = resolvedAppGroup() ?? "group.nl.hiddepepijn.uurwerk"

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

// MARK: - Data (written by the app, see packages/mobile/src/widget-data.ts)

struct WidgetItem: Codable, Hashable {
    let start: Int
    let end: Int
    let title: String
    let kind: String
    let area: String?
    let meta: String?
    /// Side by side when items overlap (from the app's agenda model).
    let lane: Int?
    let lanes: Int?
    /// A short appointment drawn full width on top, bigger than its duration.
    let overlay: Bool?
    /// Minutes at the top of this block that sit under an overlay.
    let coveredMin: Int?
}

struct WidgetDay: Codable {
    let date: String
    let items: [WidgetItem]
}

struct WidgetData: Codable {
    let generatedAt: Double
    let days: [WidgetDay]
    let overdue: [String]
    let running: String?
    let focus: String?
}

enum Store {
    static func load() -> WidgetData? {
        guard
            let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
            let data = try? Data(contentsOf: folder.appendingPathComponent("widget.json"))
        else { return nil }
        return try? JSONDecoder().decode(WidgetData.self, from: data)
    }

    static var offsetHours: Int {
        get { UserDefaults(suiteName: appGroup)?.integer(forKey: "offsetHours") ?? 0 }
        set { UserDefaults(suiteName: appGroup)?.set(newValue, forKey: "offsetHours") }
    }
}

// MARK: - The ▲ ▼ buttons

struct ShiftWindowIntent: AppIntent {
    static var title: LocalizedStringResource = "Agenda verschuiven"

    @Parameter(title: "Uren")
    var hours: Int

    init() { hours = 0 }
    init(hours: Int) { self.hours = hours }

    func perform() async throws -> some IntentResult {
        Store.offsetHours = hours == 0 ? 0 : max(-12, min(20, Store.offsetHours + hours))
        return .result()
    }
}

// MARK: - Timeline

struct AgendaEntry: TimelineEntry {
    let date: Date
    let data: WidgetData?
    let offset: Int
}

struct AgendaProvider: TimelineProvider {
    func placeholder(in context: Context) -> AgendaEntry {
        AgendaEntry(date: Date(), data: nil, offset: 0)
    }

    func getSnapshot(in context: Context, completion: @escaping (AgendaEntry) -> Void) {
        completion(AgendaEntry(date: Date(), data: Store.load(), offset: Store.offsetHours))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AgendaEntry>) -> Void) {
        let data = Store.load()
        let offset = Store.offsetHours
        let now = Date()
        // One entry every 15 minutes for two hours, so the "now" line keeps moving.
        let entries = (0..<8).map { step in
            AgendaEntry(date: now.addingTimeInterval(Double(step) * 900), data: data, offset: offset)
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

// MARK: - Look

enum Palette {
    static let background = Color(red: 0.067, green: 0.063, blue: 0.078)
    static let card = Color(red: 0.137, green: 0.129, blue: 0.157)
    static let line = Color(red: 0.149, green: 0.141, blue: 0.169)
    static let faint = Color(red: 0.553, green: 0.541, blue: 0.580)
    static let text = Color(red: 0.957, green: 0.953, blue: 0.941)
    static let accent = Color(red: 0.243, green: 0.812, blue: 0.451)
    static let now = Color(red: 1.0, green: 0.42, blue: 0.353)

    static func fill(_ area: String?) -> Color {
        switch area {
        case "stage": return accent
        case "school": return Color(red: 0.416, green: 0.655, blue: 1.0)
        case "personal": return Color(red: 0.941, green: 0.631, blue: 0.294)
        case "work": return Color(red: 0.788, green: 0.635, blue: 1.0)
        default: return faint
        }
    }

    static func ink(_ area: String?) -> Color {
        switch area {
        case "school": return Color(red: 0.043, green: 0.102, blue: 0.2)
        case "personal": return Color(red: 0.169, green: 0.09, blue: 0.02)
        case "work": return Color(red: 0.118, green: 0.063, blue: 0.2)
        default: return Color(red: 0.047, green: 0.122, blue: 0.075)
        }
    }
}

func hhmm(_ minute: Int) -> String {
    let m = ((minute % 1440) + 1440) % 1440
    return String(format: "%02d:%02d", m / 60, m % 60)
}

// MARK: - Agenda widget

struct AgendaView: View {
    let entry: AgendaEntry

    private var calendar: Calendar { Calendar.current }
    private var nowMinute: Int {
        calendar.component(.hour, from: entry.date) * 60 + calendar.component(.minute, from: entry.date)
    }
    private var windowStart: Int {
        max(0, min(20, calendar.component(.hour, from: entry.date) + entry.offset)) * 60
    }
    private var windowEnd: Int { windowStart + 240 }
    private var items: [WidgetItem] {
        (entry.data?.days.first?.items ?? []).filter { $0.end > windowStart && $0.start < windowEnd }
    }
    private var dayLabel: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "nl_NL")
        formatter.dateFormat = "EEEE d MMM"
        return formatter.string(from: entry.date).uppercased()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            GeometryReader { geo in
                timeline(height: geo.size.height, width: geo.size.width)
            }
            if let overdue = entry.data?.overdue, !overdue.isEmpty {
                Text("Te laat: " + overdue.prefix(2).joined(separator: " · "))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color(red: 0.945, green: 0.702, blue: 0.659))
                    .lineLimit(1)
            }
        }
        .widgetURL(URL(string: "uurwerk://agenda"))
    }

    private var header: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text(dayLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(Palette.accent)
                Text("\(hhmm(windowStart)) – \(hhmm(windowEnd))")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Palette.text)
            }
            Spacer()
            if entry.offset != 0 {
                Button(intent: ShiftWindowIntent(hours: 0)) {
                    Text("nu").font(.system(size: 12, weight: .semibold)).frame(width: 34, height: 30)
                }
                .buttonStyle(.plain)
                .background(Palette.card, in: Capsule())
                .foregroundColor(Palette.text)
            }
            Button(intent: ShiftWindowIntent(hours: -4)) {
                Image(systemName: "chevron.up").font(.system(size: 13, weight: .bold)).frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .background(Palette.card, in: Circle())
            .foregroundColor(Palette.text)
            Button(intent: ShiftWindowIntent(hours: 4)) {
                Image(systemName: "chevron.down").font(.system(size: 13, weight: .bold)).frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .background(Palette.card, in: Circle())
            .foregroundColor(Palette.text)
        }
    }

    private func timeline(height: CGFloat, width: CGFloat) -> some View {
        let perMinute = height / 240
        let gutter: CGFloat = 36
        return ZStack(alignment: .topLeading) {
            ForEach(0..<5, id: \.self) { hour in
                HStack(spacing: 6) {
                    Text(hhmm(windowStart + hour * 60))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundColor(Palette.faint)
                        .frame(width: gutter - 6, alignment: .leading)
                    Rectangle().fill(Palette.line).frame(height: 1)
                }
                .offset(y: CGFloat(hour * 60) * perMinute - 5)
            }
            // Overlays last, so they draw on top of the block they cover.
            ForEach(items.sorted { ($0.overlay ?? false ? 1 : 0) < ($1.overlay ?? false ? 1 : 0) }, id: \.self) { item in
                let lanes = CGFloat(max(item.lanes ?? 1, 1))
                let laneWidth = (width - gutter) / lanes
                block(item, perMinute: perMinute, width: laneWidth - (lanes > 1 ? 6 : 0))
                    .offset(
                        x: gutter + CGFloat(item.lane ?? 0) * laneWidth,
                        y: CGFloat(max(item.start, windowStart) - windowStart) * perMinute + 1
                    )
            }
            if nowMinute >= windowStart && nowMinute <= windowEnd {
                HStack(spacing: 0) {
                    Circle().fill(Palette.now).frame(width: 7, height: 7)
                    Rectangle().fill(Palette.now).frame(height: 2)
                }
                .offset(x: gutter - 4, y: CGFloat(nowMinute - windowStart) * perMinute - 3)
            }
        }
    }

    @ViewBuilder
    private func block(_ item: WidgetItem, perMinute: CGFloat, width: CGFloat) -> some View {
        let visible = min(item.end, windowEnd) - max(item.start, windowStart)
        let isOverlay = item.overlay ?? false
        let height = max(CGFloat(isOverlay ? max(visible, 30) : visible) * perMinute - 3, isOverlay ? 22 : 8)
        let covered = CGFloat(item.coveredMin ?? 0) * perMinute
        if item.kind == "break" {
            Text(height >= 12 ? "Pauze" : "")
                .font(.system(size: 9))
                .foregroundColor(Palette.faint)
                .frame(width: width, height: height, alignment: .leading)
                .padding(.leading, 8)
        } else {
            let planned = item.kind == "task" || item.kind == "meeting"
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                if height >= 36, let meta = item.meta {
                    Text(meta).font(.system(size: 10)).opacity(0.8).lineLimit(1)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, covered > 0 ? covered + 2 : 0)
            .frame(width: width, height: height, alignment: covered > 0 ? .topLeading : .leading)
            .foregroundColor(planned ? Palette.ink(item.area) : Palette.text)
            .background(
                ZStack {
                    // Opaque first: an overlay must hide what it covers, not mix with it.
                    RoundedRectangle(cornerRadius: 8).fill(Palette.background)
                    RoundedRectangle(cornerRadius: 8)
                        .fill(planned ? Palette.fill(item.area) : Palette.fill(item.area).opacity(0.22))
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(planned ? Color.clear : Palette.fill(item.area), style: StrokeStyle(lineWidth: 1.5, dash: item.kind == "travel" ? [4, 3] : []))
            )
        }
    }
}

struct AgendaWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UurwerkAgenda", provider: AgendaProvider()) { entry in
            AgendaView(entry: entry)
                .containerBackground(Palette.background, for: .widget)
        }
        .configurationDisplayName("Agenda")
        .description("De komende vier uur, met knoppen om te bladeren.")
        .supportedFamilies([.systemLarge])
    }
}

// MARK: - Quick actions widget

struct QuickEntry: TimelineEntry {
    let date: Date
    let running: String?
    /// The task focus is held for, "Handmatig", or nil when focus is off.
    let focus: String?
}

struct QuickProvider: TimelineProvider {
    private func current() -> QuickEntry {
        let data = Store.load()
        return QuickEntry(date: Date(), running: data?.running, focus: data?.focus)
    }
    func placeholder(in context: Context) -> QuickEntry { QuickEntry(date: Date(), running: nil, focus: nil) }
    func getSnapshot(in context: Context, completion: @escaping (QuickEntry) -> Void) { completion(current()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<QuickEntry>) -> Void) {
        completion(Timeline(entries: [current()], policy: .never))
    }
}

struct QuickView: View {
    let entry: QuickEntry

    private static let focusColor = Color(red: 0.608, green: 0.549, blue: 1.0)

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                tile(
                    url: "uurwerk://timer",
                    icon: entry.running == nil ? "play.fill" : "stop.fill",
                    title: entry.running == nil ? "Start timer" : "Stop timer",
                    subtitle: entry.running,
                    fill: Palette.accent,
                    ink: Color(red: 0.047, green: 0.122, blue: 0.075)
                )
                tile(url: "uurwerk://jarvis", icon: "mic.fill", title: "Jarvis", subtitle: "Praat of plan")
            }
            HStack(spacing: 8) {
                tile(
                    url: "uurwerk://focus",
                    icon: entry.focus == nil ? "moon" : "moon.fill",
                    title: entry.focus == nil ? "Focus" : "Focus aan",
                    subtitle: entry.focus,
                    fill: entry.focus == nil ? nil : Self.focusColor,
                    ink: entry.focus == nil ? nil : Color(red: 0.102, green: 0.071, blue: 0.2)
                )
                tile(url: "uurwerk://task", icon: "plus", title: "Taak", subtitle: nil)
                tile(url: "uurwerk://appointment", icon: "calendar.badge.plus", title: "Afspraak", subtitle: nil)
            }
        }
    }

    private func tile(url: String, icon: String, title: String, subtitle: String?, fill: Color? = nil, ink: Color? = nil) -> some View {
        Link(destination: URL(string: url)!) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 14, weight: .semibold))
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).font(.system(size: 13, weight: .bold)).lineLimit(1)
                    if let subtitle {
                        Text(subtitle).font(.system(size: 10)).opacity(0.75).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundColor(ink ?? Palette.text)
            .background(fill ?? Palette.card, in: RoundedRectangle(cornerRadius: 14))
        }
    }
}

struct QuickWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UurwerkSnel", provider: QuickProvider()) { entry in
            QuickView(entry: entry)
                .containerBackground(Palette.background, for: .widget)
        }
        .configurationDisplayName("Snel")
        .description("Timer, Jarvis, focus, taak of afspraak met één tik.")
        .supportedFamilies([.systemMedium])
    }
}

@main
struct UurwerkWidgets: WidgetBundle {
    var body: some Widget {
        AgendaWidget()
        QuickWidget()
    }
}
