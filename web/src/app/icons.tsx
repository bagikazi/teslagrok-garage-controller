/** Line icons drawn once as an SVG sprite (rendered in the root layout) and referenced by id. */
const PATHS = {
  garage: <><path d="M3 10.2 12 4l9 6.2V20H3z" /><path d="M7 20v-7.5h10V20M7 15.2h10M7 17.8h10" /></>,
  video: <><rect x="2.5" y="6" width="13.5" height="12" rx="3" /><path d="m16 10.4 5.2-3.1v9.4L16 13.6" /></>,
  sensor: <><circle cx="12" cy="12" r="1.8" /><path d="M8.6 8.6a4.8 4.8 0 0 0 0 6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></>,
  history: <><path d="M3.6 12a8.4 8.4 0 1 0 2.5-6" /><path d="M3.6 4.4v4h4" /><path d="M12 7.6V12l3 2" /></>,
  bulb: <><path d="M9.2 17.6h5.6M10.2 21h3.6" /><path d="M12 3a6 6 0 0 0-3.7 10.7c.8.7 1.2 1.5 1.2 2.4v1.5h5v-1.5c0-.9.4-1.7 1.2-2.4A6 6 0 0 0 12 3z" /></>,
  walk: <><circle cx="13.5" cy="4.6" r="1.9" /><path d="m8.5 21 2.8-6.4 3 2.6V21" /><path d="m6 11.6 3.4-3.6h4.3l2.2 3.3 2.6.9" /><path d="M11.3 14.6 12.6 8" /></>,
  photo: <><path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.6l1.8-2.5h5.2L16.4 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /><circle cx="12" cy="12.8" r="3.4" /></>,
  flash: <path d="M13.2 2.5 5.6 13.4h5.6l-1 8.1 7.7-11.1h-5.7z" />,
  play: <path d="M8 5.2v13.6l10.8-6.8z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.2" />,
  wifi: <><path d="M2.5 9a14 14 0 0 1 19 0M5.6 12.4a9.5 9.5 0 0 1 12.8 0M8.8 15.8a5 5 0 0 1 6.4 0" /><circle cx="12" cy="19" r=".9" /></>,
  server: <><rect x="3.5" y="4" width="17" height="7" rx="2" /><rect x="3.5" y="13" width="17" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9.6 9.6h4.8v4.8H9.6zM9 2.6V6M15 2.6V6M9 18v3.4M15 18v3.4M2.6 9H6M2.6 15H6M18 9h3.4M18 15h3.4" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.8 2.8 5.3-5.6" /></>,
  warn: <><path d="M10.3 4.2a2 2 0 0 1 3.4 0l7.6 13.2a2 2 0 0 1-1.7 3H4.4a2 2 0 0 1-1.7-3z" /><path d="M12 9.6v4.2M12 17v.1" /></>,
  octagon: <><path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z" /><path d="M12 7.6v5.6M12 16.4v.1" /></>,
  fault: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  unknown: <><circle cx="12" cy="12" r="9" strokeDasharray="3 3" /><path d="M8.5 12h7" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  magnet: <><path d="M5 4h4.5v7.5a2.5 2.5 0 0 0 5 0V4H19v7.5a7 7 0 0 1-14 0z" /><path d="M5 8h4.5M14.5 8H19" /></>,
  battery: <><rect x="2.5" y="7" width="17" height="10" rx="2.5" /><path d="M21.5 10.5v3M6 10.5v3" /></>,
  thermo: <><path d="M10 4.6a2 2 0 0 1 4 0v9.2a4 4 0 1 1-4 0z" /><path d="M12 10v6" /></>,
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21" />,
  antenna: <><path d="M12 11v10M8.5 21h7" /><circle cx="12" cy="8.6" r="1.5" /><path d="M8.6 5.2a4.8 4.8 0 0 0 0 6.8M15.4 5.2a4.8 4.8 0 0 1 0 6.8M5.8 2.6a8.6 8.6 0 0 0 0 12M18.2 2.6a8.6 8.6 0 0 1 0 12" /></>,
  chev: <path d="m9 5.5 6.5 6.5L9 18.5" />,
  up: <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />,
  down: <path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" />,
  arrows: <path d="M8 20V4M4.5 7.5 8 4l3.5 3.5M16 4v16M12.5 16.5 16 20l3.5-3.5" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  "eye-off": <path d="M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.4 6.9A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  refresh: <><path d="M20 11.2a8 8 0 1 0-2.4 5.6" /><path d="M20 4.6v6.6h-6.6" /></>,
  send: <path d="M20.5 3.5 10.2 13.8M20.5 3.5l-6.6 17-3.7-6.7-6.7-3.7z" />,
  target: <><circle cx="12" cy="12" r="7.5" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /><circle cx="12" cy="12" r="1.6" /></>,
  test: <><path d="M9 3h6M10 3v6l-5.2 9.1A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.9L14 9V3" /><path d="M7.5 15h9" /></>
} as const;

export type IconName = keyof typeof PATHS;

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>{(Object.keys(PATHS) as IconName[]).map((name) => <symbol key={name} id={`i-${name}`} viewBox="0 0 24 24">{PATHS[name]}</symbol>)}</defs>
    </svg>
  );
}

export function Icon({ name, size, fill }: { name: IconName; size?: "sm" | "xs"; fill?: boolean }) {
  return <svg className={`ic${size ? ` ${size}` : ""}${fill ? " fill" : ""}`} aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}

export function Spinner({ size }: { size?: number }) {
  return <span className="spin" style={size ? { width: size, height: size } : undefined} aria-hidden="true" />;
}
