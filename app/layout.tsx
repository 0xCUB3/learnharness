import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityDock, ActivityProvider } from "@/components/activity-dock";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body className={`${ui.variable} ${prose.variable} min-h-dvh antialiased`}>
			<SidebarProvider>
									<ActivityProvider>
						<AppShell>{children}</AppShell>
						{/* The reserved bottom-right corner of every view — renders
					    nothing while no background process runs. */}
						<ActivityDock />
					</ActivityProvider>
							</SidebarProvider>
		</body>
		</html>
	);
}
