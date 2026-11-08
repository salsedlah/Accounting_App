import type { Metadata, Viewport } from "next";
import "@fontsource-variable/cairo";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "حساب | نظام المحاسبة والمخزون",
    template: "%s | حساب",
  },
  description:
    "نظام عربي متكامل للمحاسبة والمخزون ونقاط البيع، يعمل دون اتصال ويزامن البيانات بأمان.",
  applicationName: "حساب",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "حساب",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#1e6756",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
