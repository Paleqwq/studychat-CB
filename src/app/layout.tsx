import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "学习对话",
  description: "在线学习与对话。",
  robots: { index: false, follow: false }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
