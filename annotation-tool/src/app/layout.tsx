import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bitter Melon Annotation Tool",
  description: "Multi-user annotation system for bitter melon ridge segmentation and breakpoint labeling",
};

export const viewport: Viewport = {
  themeColor: "#fcfcfd",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body className="antialiased">{children}</body>
    </html>
  );
}
