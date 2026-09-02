import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { TreePanelModeProvider } from "@/components/tree-panel";

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body className="min-h-dvh antialiased">
			<SidebarProvider>
				<TreePanelModeProvider>
					<AppShell>{children}</AppShell>
				</TreePanelModeProvider>
			</SidebarProvider>
		</body>
		</html>
	);
}
