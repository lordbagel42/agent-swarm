import { createRemoteJWKSet, jwtVerify } from "jose";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Every request needs a Cloudflare Access token for this app, checked here as well as at Cloudflare, so the
 * dashboard stays closed if a route ever reaches it without Access in front. It fails closed: without
 * CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD it serves nothing. DASHBOARD_AUTH=none turns the check off for
 * local development only.
 */
const team = process.env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/$/, "");
const audience = process.env.CF_ACCESS_AUD;
const keys = team ? createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`)) : null;

export async function proxy(request: NextRequest) {
	if (process.env.DASHBOARD_AUTH === "none") return NextResponse.next();
	if (!keys || !team || !audience) return new NextResponse("Cloudflare Access is not configured.", { status: 503 });
	const token = request.headers.get("cf-access-jwt-assertion") ?? request.cookies.get("CF_Authorization")?.value;
	if (!token) return new NextResponse("Sign in through Cloudflare Access.", { status: 401 });
	try {
		await jwtVerify(token, keys, { issuer: team, audience });
		return NextResponse.next();
	} catch {
		return new NextResponse("Invalid Cloudflare Access token.", { status: 403 });
	}
}

export const config = { matcher: ["/((?!healthz$).*)"] };
