/** Liveness for the kubelet. Reads nothing, so it's the one path served without a Cloudflare Access token. */
export function GET() {
	return new Response("ok");
}
