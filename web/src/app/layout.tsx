import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IconSprite } from "./icons";
import "./globals.css";

export const metadata: Metadata = {
  title: "Garaj",
  description: "Garaj kapısını ve kamerayı güvenle izleyin ve kontrol edin.",
  applicationName: "Garaj",
  manifest: "/manifest.webmanifest"
};

export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#131210" }, { media: "(prefers-color-scheme: light)", color: "#f2efea" }],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

// Fonts load from Google Fonts with system fallbacks (tokens.css), so a blocked
// font host only changes the typeface, never the layout or the build.
const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..700&family=Figtree:wght@400..700&family=JetBrains+Mono:wght@400;500;600&display=swap";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="tr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body><IconSprite />{children}</body>
    </html>
  );
}
