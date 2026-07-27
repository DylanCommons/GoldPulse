import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GoldPulse — Gold news, read for direction",
  description:
    "Real-time gold (XAU/USD) news monitoring with AI bullish/bearish classification and a daily pre-session brief.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
