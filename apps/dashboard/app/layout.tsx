import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
	title: "agent-swarm",
	description: "The swarm's board, workers, and cluster, live.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={cn("dark font-sans antialiased", GeistSans.variable, GeistMono.variable)}>
			<body>
				<TooltipProvider delayDuration={150}>{children}</TooltipProvider>
			</body>
		</html>
	);
}
