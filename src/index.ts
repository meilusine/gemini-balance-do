import { Hono } from 'hono';
import { Render, RenderLogin } from './render';
import { LoadBalancer } from './handler';
import { createAdminCookie, isAdminAuthenticated, isApiAuthenticated } from './auth';

type Bindings = Env & {
	AUTH_KEY?: string;
	HOME_ACCESS_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const missingSecret = (name: string) =>
	new Response(`${name} is not configured. Add it as a Cloudflare Worker secret.`, {
		status: 503,
		headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
	});

// The / route returns the admin UI.
app.get('/', (c) => {
	if (!c.env.HOME_ACCESS_KEY) return missingSecret('HOME_ACCESS_KEY');
	if (!isAdminAuthenticated(c.req.raw, c.env.HOME_ACCESS_KEY)) return c.html(RenderLogin());
	return c.html(Render());
});

app.post('/', async (c) => {
	if (!c.env.HOME_ACCESS_KEY) return missingSecret('HOME_ACCESS_KEY');
	const body = await c.req.parseBody();
	const key = typeof body.key === 'string' ? body.key : '';
	if (key !== c.env.HOME_ACCESS_KEY) return c.html(RenderLogin('管理密码不正确。'), 401);
	return new Response(null, {
		status: 303,
		headers: {
			Location: '/',
			'Set-Cookie': createAdminCookie(c.env.HOME_ACCESS_KEY),
		},
	});
});

// All other requests are forwarded to the Durable Object.
// This includes /api/* for the admin panel's backend and the gemini proxy.
app.all('*', async (c) => {
	const isAdminRoute = c.req.path.startsWith('/api/');
	if (isAdminRoute) {
		if (!c.env.HOME_ACCESS_KEY) return missingSecret('HOME_ACCESS_KEY');
		if (!isAdminAuthenticated(c.req.raw, c.env.HOME_ACCESS_KEY)) return c.json({ error: 'Unauthorized' }, 401);
	} else {
		if (!c.env.AUTH_KEY) return missingSecret('AUTH_KEY');
		if (!isApiAuthenticated(c.req.raw, c.env.AUTH_KEY)) return c.json({ error: 'Unauthorized' }, 401);
	}

	const id: DurableObjectId = c.env.LOAD_BALANCER.idFromName('loadbalancer');
	const stub = c.env.LOAD_BALANCER.get(id, { locationHint: 'wnam' });
	// Pass the original request to the durable object.
	const resp = await stub.fetch(c.req.raw);
	return new Response(resp.body, {
		status: resp.status,
		headers: resp.headers,
	});
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export { LoadBalancer };
