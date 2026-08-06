import type { Metadata } from "next";
import "./globals.css";
import "./v4.css";
import React from "react";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "万能导入 V4 - 异步事件驱动批量下单系统",
  description: "支持异步任务、批量处理与全链路可观测性的多格式订单导入系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
