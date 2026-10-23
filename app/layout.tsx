import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Трекер",
  description: "Личный трекер проектов, задач и пингов",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
