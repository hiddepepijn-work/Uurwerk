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

/// A colour from 0xRRGGBB, so the values read the same as in the design (STIJL.md, "Inkt").
func hexColor(_ value: UInt32) -> Color {
    Color(
        red: Double((value >> 16) & 0xFF) / 255,
        green: Double((value >> 8) & 0xFF) / 255,
        blue: Double(value & 0xFF) / 255
    )
}

/// The "Inkt" look: near-black ink, muted area colours. Per area there is a fill (solid block),
/// an ink (text on that fill), a tint (soft background) and a soft (text on dark).
enum Palette {
    static let background = hexColor(0x0E0F13)
    /// Tiles and cards.
    static let card = hexColor(0x1A1B21)
    /// Hour lines and small round buttons.
    static let line = hexColor(0x1F2027)
    static let control = hexColor(0x1F2027)
    static let faint = hexColor(0x6F6E78)
    static let dim = hexColor(0xA3A2AB)
    static let text = hexColor(0xF3F2EE)
    static let accent = hexColor(0x5DAE86)
    static let accentInk = hexColor(0x0E1A14)
    static let accentSoft = hexColor(0x86BFA0)
    /// Behind the Live Activity's ring.
    static let ringTrack = hexColor(0x1F2A24)
    static let now = hexColor(0xCC6F62)
    /// Danger / overdue: text, and the flat colour behind it.
    static let dangerText = hexColor(0xD98476)
    static let dangerFill = hexColor(0x3A1F1C)
    /// "Bezig" on the Live Activity.
    static let busyFill = hexColor(0x1D2A3A)
    static let busyText = hexColor(0x98AFD8)
    /// Focus on: the work area's tint and soft text.
    static let focusFill = hexColor(0x221E2C)
    static let focusText = hexColor(0xB3A4D6)

    static func fill(_ area: String?) -> Color {
        switch area {
        case "stage": return accent
        case "school": return hexColor(0x7F9FD6)
        case "personal": return hexColor(0xCF9A63)
        case "work": return hexColor(0xA997CF)
        default: return hexColor(0x8D8A94)
        }
    }

    static func ink(_ area: String?) -> Color {
        switch area {
        case "school": return hexColor(0x0B1220)
        case "personal": return hexColor(0x1F1406)
        case "work": return hexColor(0x120F1A)
        case "stage": return accentInk
        default: return hexColor(0x141318)
        }
    }

    static func tint(_ area: String?) -> Color {
        switch area {
        case "stage": return hexColor(0x1B2721)
        case "school": return hexColor(0x182030)
        case "personal": return hexColor(0x2A2119)
        case "work": return focusFill
        default: return hexColor(0x1C1C21)
        }
    }

    static func soft(_ area: String?) -> Color {
        switch area {
        case "stage": return accentSoft
        case "school": return busyText
        case "personal": return hexColor(0xD5AA7B)
        case "work": return focusText
        default: return dim
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
        VStack(alignment: .leading, spacing: 10) {
            header
            GeometryReader { geo in
                timeline(height: geo.size.height, width: geo.size.width)
            }
            if let overdue = entry.data?.overdue, !overdue.isEmpty {
                Text("Te laat: " + overdue.prefix(2).joined(separator: " · "))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Palette.dangerText)
                    .lineLimit(1)
            }
        }
        .widgetURL(URL(string: "uurwerk://agenda"))
    }

    private var header: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text(dayLabel)
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.8)
                    .foregroundColor(Palette.accentSoft)
                Text("\(hhmm(windowStart)) – \(hhmm(windowEnd))")
                    .font(.system(size: 19, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(Palette.text)
            }
            Spacer()
            if entry.offset != 0 {
                Button(intent: ShiftWindowIntent(hours: 0)) {
                    Text("nu").font(.system(size: 12, weight: .bold)).padding(.horizontal, 11).frame(height: 30)
                }
                .buttonStyle(.plain)
                .background(Palette.control, in: Capsule())
                .foregroundColor(Palette.text)
            }
            Button(intent: ShiftWindowIntent(hours: -4)) {
                Image(systemName: "chevron.up").font(.system(size: 13, weight: .bold)).frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .background(Palette.control, in: Circle())
            .foregroundColor(Palette.text)
            Button(intent: ShiftWindowIntent(hours: 4)) {
                Image(systemName: "chevron.down").font(.system(size: 13, weight: .bold)).frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .background(Palette.control, in: Circle())
            .foregroundColor(Palette.text)
        }
    }

    private func timeline(height: CGFloat, width: CGFloat) -> some View {
        let perMinute = height / 240
        let gutter: CGFloat = 40
        return ZStack(alignment: .topLeading) {
            ForEach(0..<5, id: \.self) { hour in
                HStack(spacing: 6) {
                    Text(hhmm(windowStart + hour * 60))
                        .font(.system(size: 10, weight: .semibold))
                        .monospacedDigit()
                        .foregroundColor(Palette.faint)
                        .frame(width: gutter - 6, alignment: .leading)
                    Rectangle().fill(Palette.line).frame(height: 1)
                }
                .offset(y: CGFloat(hour * 60) * perMinute - 6)
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
                    Circle().fill(Palette.now).frame(width: 8, height: 8)
                    Rectangle().fill(Palette.now).frame(height: 2)
                }
                .offset(x: gutter - 4, y: CGFloat(nowMinute - windowStart) * perMinute - 4)
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
            // Pause: a dotted line on the left, no block.
            Text(height >= 12 ? "Pauze" : "")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(Palette.faint)
                .padding(.leading, 8)
                .frame(width: width, height: height, alignment: .leading)
                .overlay(alignment: .leading) {
                    Path { path in
                        path.move(to: CGPoint(x: 1, y: 0))
                        path.addLine(to: CGPoint(x: 1, y: height))
                    }
                    .stroke(Palette.faint, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 4]))
                    .frame(width: 2, height: height)
                }
        } else {
            // Tasks and meetings: solid fill with dark ink. Appointments and travel: the soft
            // tint with a 1.5pt edge in the fill colour (dashed for travel).
            let planned = item.kind == "task" || item.kind == "meeting"
            let roomy = height >= 26
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 12, weight: .bold))
                    .lineLimit(1)
                if height >= 36, let meta = item.meta {
                    Text(meta).font(.system(size: 10, weight: .semibold)).opacity(0.8).lineLimit(1)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, covered > 0 ? covered + 4 : (roomy ? 5 : 0))
            .frame(width: width, height: height, alignment: covered > 0 || roomy ? .topLeading : .leading)
            .foregroundColor(planned ? Palette.ink(item.area) : Palette.soft(item.area))
            .background(
                ZStack {
                    // Opaque first: an overlay must hide what it covers, not mix with it.
                    RoundedRectangle(cornerRadius: 10).fill(Palette.background)
                    RoundedRectangle(cornerRadius: 10)
                        .fill(planned ? Palette.fill(item.area) : Palette.tint(item.area))
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(planned ? Color.clear : Palette.fill(item.area), style: StrokeStyle(lineWidth: 1.5, dash: item.kind == "travel" ? [4, 3] : []))
            )
            .clipShape(RoundedRectangle(cornerRadius: 10))
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

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                tile(
                    url: "uurwerk://timer",
                    icon: entry.running == nil ? "play.fill" : "stop.fill",
                    title: entry.running == nil ? "Start timer" : "Stop timer",
                    subtitle: entry.running,
                    large: true,
                    fill: Palette.accent,
                    ink: Palette.accentInk
                )
                tile(url: "uurwerk://jarvis", icon: "mic.fill", title: "Jarvis", subtitle: "Praat of plan", large: true)
            }
            HStack(spacing: 8) {
                // Focus on: the muted violet tint with soft violet text, not a bright block.
                tile(
                    url: "uurwerk://focus",
                    icon: entry.focus == nil ? "moon" : "moon.fill",
                    title: entry.focus == nil ? "Focus" : "Focus aan",
                    subtitle: entry.focus,
                    fill: entry.focus == nil ? nil : Palette.focusFill,
                    ink: entry.focus == nil ? nil : Palette.focusText
                )
                tile(url: "uurwerk://task", icon: "plus", title: "Taak", subtitle: nil)
                tile(url: "uurwerk://appointment", icon: "calendar.badge.plus", title: "Afspraak", subtitle: nil)
            }
        }
        .padding(12)
    }

    /// Icon top-left, title (and subtitle) bottom-left. On a plain tile the subtitle is dim;
    /// on a coloured one it is the tile's ink, a little faded.
    private func tile(url: String, icon: String, title: String, subtitle: String?, large: Bool = false, fill: Color? = nil, ink: Color? = nil) -> some View {
        Link(destination: URL(string: url) ?? URL(fileURLWithPath: "/")) {
            VStack(alignment: .leading, spacing: 0) {
                Image(systemName: icon).font(.system(size: large ? 15 : 14, weight: .bold))
                Spacer(minLength: 2)
                Text(title)
                    .font(.system(size: large ? 14 : 13, weight: .bold, design: .rounded))
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: large ? 11 : 10, weight: .semibold))
                        .lineLimit(1)
                        .foregroundColor(ink.map { $0.opacity(0.8) } ?? Palette.dim)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .foregroundColor(ink ?? Palette.text)
            .background(fill ?? Palette.card, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct QuickWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UurwerkSnel", provider: QuickProvider()) { entry in
            // Own 12pt margin (as in the design) instead of the system's wider one, so the
            // two rows of tiles have room for icon, title and subtitle.
            QuickView(entry: entry)
                .containerBackground(Palette.background, for: .widget)
        }
        .contentMarginsDisabled()
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
        CheckinLiveActivity()
    }
}
