import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "LedgerPilot — Autonomous AP, Contract Compliance & Wire-Fraud Defense",
  description:
    "Production FinOps AI Command Center with PDF Forensics, Decimal 3-Way Matching, pgvector Contract RAG, LangGraph HITL Checkpoints, and ISO 20022 Settlement.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable} dark`}>
      <body className="min-h-screen font-sans text-slate-900 antialiased dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}