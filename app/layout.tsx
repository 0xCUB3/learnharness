import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityDock, ActivityProvider } from "@/components/activity-dock";

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body className="min-h-dvh antialiased">
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
