const ADMIN_COOKIE = 'gemini-balance-admin';

const safeEqual = (actual: string | null | undefined, expected: string | null | undefined) => {
	if (!actual || !expected || actual.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < actual.length; index++) {
		difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
	}
	return difference === 0;
};

const getBearerToken = (request: Request) => {
	const authorization = request.headers.get('authorization');
	return authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
};

const getCookie = (request: Request, name: string) => {
	const cookieHeader = request.headers.get('cookie');
	if (!cookieHeader) return undefined;
	for (const entry of cookieHeader.split(';')) {
		const separator = entry.indexOf('=');
		if (separator < 0) continue;
		if (entry.slice(0, separator).trim() === name) {
			return decodeURIComponent(entry.slice(separator + 1).trim());
		}
	}
	return undefined;
};

export const isAdminAuthenticated = (request: Request, adminKey?: string) =>
	safeEqual(getBearerToken(request), adminKey) || safeEqual(getCookie(request, ADMIN_COOKIE), adminKey);

export const isApiAuthenticated = (request: Request, apiKey?: string) => {
	const url = new URL(request.url);
	return (
		safeEqual(url.searchParams.get('key'), apiKey) ||
		safeEqual(request.headers.get('x-goog-api-key'), apiKey) ||
		safeEqual(getBearerToken(request), apiKey)
	);
};

export const createAdminCookie = (adminKey: string) =>
	`${ADMIN_COOKIE}=${encodeURIComponent(adminKey)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
