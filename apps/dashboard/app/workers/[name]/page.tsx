import { WorkerPage } from "@/components/worker-page";

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	return <WorkerPage name={decodeURIComponent(name)} />;
}
