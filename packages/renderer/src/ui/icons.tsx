/**
 * Inline SVG icons — no icon package, no network fetch, no extra dependency to audit.
 * All 24x24 on a 2px stroke so they sit consistently next to 14px text.
 */

interface IconProps {
  size?: number
  className?: string
}

const svg = (path: React.ReactNode) =>
  function Icon({ size = 18, className = '' }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    )
  }

export const ClockIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>
)

export const CalendarIcon = svg(
  <>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </>
)

export const ChecklistIcon = svg(
  <>
    <path d="M3 6l2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3" />
    <path d="M12 6h9M12 13h9M12 20h9" />
  </>
)

export const DocumentIcon = svg(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>
)

export const GearIcon = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>
)

export const StopIcon = svg(<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />)

export const PlayIcon = svg(<path d="M8 5l11 7-11 7z" fill="currentColor" />)

export const CameraIcon = svg(
  <>
    <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="12.5" r="3.5" />
  </>
)

export const PlusIcon = svg(<path d="M12 5v14M5 12h14" />)

export const SearchIcon = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
)

export const FilterIcon = svg(<path d="M3 5h18l-7 8v6l-4 2v-8z" />)

export const BellIcon = svg(
  <>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </>
)

export const ActivityIcon = svg(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />)

export const TrendingUpIcon = svg(
  <>
    <path d="M22 7 13.5 15.5 8.5 10.5 2 17" />
    <path d="M16 7h6v6" />
  </>
)

export const BarChartIcon = svg(
  <>
    <path d="M6 20V10M12 20V4M18 20v-6" />
  </>
)

export const ShieldIcon = svg(
  <>
    <path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </>
)

export const CheckIcon = svg(<path d="M20 6 9 17l-5-5" />)

export const CloseIcon = svg(<path d="M18 6 6 18M6 6l12 12" />)

export const FolderIcon = svg(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
)

export const FlagIcon = svg(
  <>
    <path d="M4 21V4M4 4h12l-2 4 2 4H4" />
  </>
)

export const InfoIcon = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-5M12 8h.01" />
  </>
)

export const SendIcon = svg(<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />)

export const FilmIcon = svg(
  <>
    <rect x="2.5" y="4" width="19" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M2.5 12h19M2.5 8h4.5M2.5 16h4.5M17 8h4.5M17 16h4.5" />
  </>
)

export const TrashIcon = svg(
  <>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" />
  </>
)

export const SparkIcon = svg(
  <>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="M12 8.5 13.2 11l2.8 1-2.8 1-1.2 2.5L10.8 13 8 12l2.8-1z" fill="currentColor" />
  </>
)

export const MicIcon = svg(
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </>
)
