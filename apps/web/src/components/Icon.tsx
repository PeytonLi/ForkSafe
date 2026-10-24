const PATHS = {
  home: "M2.5 7 8 2.5 13.5 7v5.75a.75.75 0 0 1-.75.75H10V10H6v3.5H3.25a.75.75 0 0 1-.75-.75Z",
  health: "M1.5 8.5h2.75L6 4l3.25 8.5L11 8.5h3.5",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.5 10.5l3 3",
  capture: "M2.75 4h7a1.25 1.25 0 0 1 1.25 1.25v5.5A1.25 1.25 0 0 1 9.75 12h-7A1.25 1.25 0 0 1 1.5 10.75v-5.5A1.25 1.25 0 0 1 2.75 4ZM11 7.25l3.5-2v5.5l-3.5-2",
  environments: "M2.5 2.5h4.25v4.25H2.5ZM9.25 2.5h4.25v4.25H9.25ZM2.5 9.25h4.25v4.25H2.5ZM9.25 9.25h4.25v4.25H9.25Z",
  evidence: "M4 1.75h5l3.25 3.25v8.5a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75V2.5A.75.75 0 0 1 4 1.75ZM9 1.75V5h3.25M5.75 8.25h4.5M5.75 11h3",
  ask: "M3 2.75h10a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-.75.75H7l-3.25 2.75V10.75H3a.75.75 0 0 1-.75-.75V3.5A.75.75 0 0 1 3 2.75ZM5.25 6.5h.01M8 6.5h.01M10.75 6.5h.01",
  timeline: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM8 4.75V8l2.25 1.5",
  compare: "M2 5h9.5M9 2.5 11.5 5 9 7.5M14 11H4.5M7 8.5 4.5 11 7 13.5",
  sidebar: "M3 2.5h10A1.5 1.5 0 0 1 14.5 4v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5ZM6 2.5v11",
  menu: "M2.5 4.25h11M2.5 8h11M2.5 11.75h11",
  close: "M4 4l8 8M12 4l-8 8",
  chevronDown: "m4.5 6 3.5 3.5L11.5 6",
  chevronRight: "m6 4.5 3.5 3.5L6 11.5",
  external: "M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.5 2.5 7.5 8.5",
  user: "M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM2.75 14c.5-2.6 2.6-4.25 5.25-4.25s4.75 1.65 5.25 4.25",
  enter: "M13 3.5v4.75a1.25 1.25 0 0 1-1.25 1.25H3.5M6 7 3.5 9.5 6 12",
  plus: "M8 2.5v11M2.5 8h11",
} as const;

export type IconName = keyof typeof PATHS;

export const SECTION_ICONS: Record<string, IconName> = {
  capture: "capture",
  environments: "environments",
  evidence: "evidence",
  ask: "ask",
  timeline: "timeline",
  compare: "compare",
};

export function Icon({ name, className, size = 16 }: { name: IconName; className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 2.8 27 7v8.2c0 7-4.6 11.5-11 14-6.4-2.5-11-7-11-14V7l11-4.2Z" />
      <path d="M10 17.1h4.1l2-5.1 2.1 8 1.8-4.2H24" />
      <circle cx="10" cy="17.1" r="1" />
    </svg>
  );
}
