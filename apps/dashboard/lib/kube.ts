import { readFile } from "node:fs/promises";
import type { NodeRow, PodRow, Usage } from "./types";

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * In the cluster: the API server and the pod's service account token (its CA comes from NODE_EXTRA_CA_CERTS).
 * Elsewhere: KUBE_API_URL, such as `kubectl proxy`'s, with KUBE_TOKEN when it needs one.
 */
async function target(): Promise<{ base: string; token: string | null } | null> {
	if (process.env.KUBE_API_URL) return { base: process.env.KUBE_API_URL, token: process.env.KUBE_TOKEN ?? null };
	const host = process.env.KUBERNETES_SERVICE_HOST;
	if (!host) return null;
	const token = await readFile(`${SERVICE_ACCOUNT}/token`, "utf8");
	return { base: `https://${host}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`, token: token.trim() };
}

export function kubeConfigured(): boolean {
	return Boolean(process.env.KUBE_API_URL || process.env.KUBERNETES_SERVICE_HOST);
}

async function get<T>(base: string, token: string | null, path: string): Promise<T> {
	const response = await fetch(`${base}${path}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
		signal: AbortSignal.timeout(10_000),
		cache: "no-store",
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
	return (await response.json()) as T;
}

/** CPU in cores, memory in bytes, from Kubernetes quantities such as `250m`, `123456n`, `900Mi`. */
export function quantity(value: string | undefined): number | null {
	if (!value) return null;
	const match = /^([0-9.]+)([a-zA-Z]*)$/.exec(value);
	if (!match) return null;
	const number = Number.parseFloat(match[1]);
	const units: Record<string, number> = {
		"": 1,
		n: 1e-9,
		u: 1e-6,
		m: 1e-3,
		k: 1e3,
		M: 1e6,
		G: 1e9,
		T: 1e12,
		Ki: 1024,
		Mi: 1024 ** 2,
		Gi: 1024 ** 3,
		Ti: 1024 ** 4,
	};
	const unit = units[match[2]];
	return unit === undefined ? null : number * unit;
}

function usage(resources: Record<string, string> | undefined): Usage {
	return { cpu: quantity(resources?.cpu), memory: quantity(resources?.memory) };
}

function sum(values: Usage[]): Usage {
	const add = (key: keyof Usage) =>
		values.some((value) => value[key] !== null) ? values.reduce((total, value) => total + (value[key] ?? 0), 0) : null;
	return { cpu: add("cpu"), memory: add("memory") };
}

type Pod = {
	metadata: { name: string; namespace: string; labels?: Record<string, string> };
	spec: {
		nodeName?: string;
		containers: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }[];
	};
	status: {
		phase: string;
		startTime?: string;
		conditions?: { type: string; status: string }[];
		containerStatuses?: { restartCount: number }[];
	};
};
type Node = {
	metadata: { name: string; labels?: Record<string, string> };
	status: {
		capacity: Record<string, string>;
		allocatable: Record<string, string>;
		conditions: { type: string; status: string }[];
		nodeInfo: { architecture: string; kubeletVersion: string };
	};
};
type Metrics = {
	metadata: { name: string; namespace?: string };
	usage?: Record<string, string>;
	containers?: { usage: Record<string, string> }[];
};

/** Every node with its usage, and the pods of the namespaces the dashboard watches. */
export async function readCluster(namespaces: string[]): Promise<{ nodes: NodeRow[]; unscheduled: PodRow[] }> {
	const api = await target();
	if (!api) throw new Error("not in a cluster, and KUBE_API_URL is not set");
	const { base, token } = api;
	const [nodes, nodeMetrics, ...perNamespace] = await Promise.all([
		get<{ items: Node[] }>(base, token, "/api/v1/nodes"),
		get<{ items: Metrics[] }>(base, token, "/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
		...namespaces.map((namespace) =>
			Promise.all([
				get<{ items: Pod[] }>(base, token, `/api/v1/namespaces/${namespace}/pods`),
				get<{ items: Metrics[] }>(base, token, `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`).catch(
					() => ({ items: [] }),
				),
			]),
		),
	]);

	const podUsage = new Map<string, Usage>();
	const pods: PodRow[] = [];
	for (const [list, metrics] of perNamespace) {
		for (const metric of metrics.items) {
			podUsage.set(
				`${metric.metadata.namespace}/${metric.metadata.name}`,
				sum((metric.containers ?? []).map((container) => usage(container.usage))),
			);
		}
		for (const pod of list.items) {
			const { name, namespace, labels = {} } = pod.metadata;
			pods.push({
				name,
				namespace,
				app: labels["app.kubernetes.io/name"] ?? labels.app ?? name,
				node: pod.spec.nodeName ?? null,
				phase: pod.status.phase,
				ready:
					pod.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ??
					false,
				restarts: (pod.status.containerStatuses ?? []).reduce((total, container) => total + container.restartCount, 0),
				startedAt: pod.status.startTime ?? null,
				usage: podUsage.get(`${namespace}/${name}`) ?? { cpu: null, memory: null },
				requests: sum(pod.spec.containers.map((container) => usage(container.resources?.requests))),
				limits: sum(pod.spec.containers.map((container) => usage(container.resources?.limits))),
			});
		}
	}

	const nodeUsage = new Map(nodeMetrics.items.map((metric) => [metric.metadata.name, usage(metric.usage)]));
	const rows = nodes.items
		.map((node): NodeRow => {
			const labels = node.metadata.labels ?? {};
			return {
				name: node.metadata.name,
				roles: Object.keys(labels)
					.filter((label) => label.startsWith("node-role.kubernetes.io/"))
					.map((label) => label.slice("node-role.kubernetes.io/".length)),
				ready: node.status.conditions.some((condition) => condition.type === "Ready" && condition.status === "True"),
				arch: node.status.nodeInfo.architecture,
				kubelet: node.status.nodeInfo.kubeletVersion,
				capacity: usage(node.status.capacity),
				allocatable: usage(node.status.allocatable),
				usage: nodeUsage.get(node.metadata.name) ?? { cpu: null, memory: null },
				pods: pods.filter((pod) => pod.node === node.metadata.name),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	return { nodes: rows, unscheduled: pods.filter((pod) => !pod.node) };
}
