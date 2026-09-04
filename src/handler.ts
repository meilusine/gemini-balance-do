import { DurableObject } from 'cloudflare:workers';

class HttpError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = this.constructor.name;
		this.status = status;
	}
}

const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
	const newHeaders = new Headers(headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	return { headers: newHeaders, status, statusText };
};

const handleOPTIONS = async () => {
	return new Response(null, {
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': '*',
			'Access-Control-Allow-Headers': '*',
		},
	});
};

const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
const API_CLIENT = 'genai-js/0.21.0';
const MAX_API_KEY_ATTEMPTS = 3;
const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 500, 502, 503, 504]);
const MINUTE_COOLDOWN_MS = 90 * 1000;
const UNKNOWN_429_COOLDOWN_MS = 5 * 60 * 1000;
const INVALID_KEY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const SAFETY_CATEGORIES = [
	'HARM_CATEGORY_HATE_SPEECH',
	'HARM_CATEGORY_SEXUALLY_EXPLICIT',
	'HARM_CATEGORY_DANGEROUS_CONTENT',
	'HARM_CATEGORY_HARASSMENT',
	'HARM_CATEGORY_CIVIC_INTEGRITY',
	'HARM_CATEGORY_JAILBREAK',
];

const minimumSafetySettings = () => SAFETY_CATEGORIES.map((category) => ({ category, threshold: 'OFF' }));

const makeHeaders = (apiKey: string, more?: Record<string, string>) => ({
	'x-goog-api-client': API_CLIENT,
	...(apiKey && { 'x-goog-api-key': apiKey }),
	...more,
});

const CONTINUE_AFTER_MODEL_PROMPT = 'Continue the previous response naturally. Do not repeat existing content.';

const requiresTrailingUserTurn = (model: string) => {
	const match = model.match(/^gemini-(\d+)\.(\d+)/);
	if (!match) return false;

	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 3 || (major === 3 && minor >= 6);
};

const ensureTrailingUserTurn = (body: any, model: string) => {
	if (
		!requiresTrailingUserTurn(model) ||
		!Array.isArray(body?.contents) ||
		body.contents[body.contents.length - 1]?.role !== 'model'
	) {
		return body;
	}

	body.contents.push({
		role: 'user',
		parts: [{ text: CONTINUE_AFTER_MODEL_PROMPT }],
	});
	return body;
};

const isGemini3Model = (model: string) => /^gemini-3(?:[.-]|$)/.test(model);

const requiresGemini3SamplingDefaults = (model: string) => {
	const match = model.match(/^gemini-3\.(\d+)(?:[.-]|$)/);
	return Boolean(match && Number(match[1]) >= 6);
};

const normalizeGemini3Body = (body: any, model: string) => {
	if (!isGemini3Model(model) || !body || typeof body !== 'object' || Array.isArray(body)) return body;

	const config = body.generationConfig;
	if (!config || typeof config !== 'object' || Array.isArray(config)) return body;

	// Multiple candidates are unsupported across Gemini 3.x.
	delete config.candidateCount;

	// Gemini 3.6+ requires the model-tuned sampling defaults. Gemini 3.5 merely
	// recommends them, so retain explicit roleplay settings for compatibility.
	if (requiresGemini3SamplingDefaults(model)) {
		delete config.temperature;
		delete config.topP;
		delete config.topK;
	}

	const thinkingConfig = config.thinkingConfig;
	if (thinkingConfig && typeof thinkingConfig === 'object' && !Array.isArray(thinkingConfig)) {
		// Gemini 3.7/3.8 Flash and Gemini 3.1 Pro reject the "minimal" level.
		if (
			thinkingConfig.thinkingLevel === 'minimal' &&
			(/^gemini-3\.(?:7|8)-flash(?:$|[-:])/.test(model) || /^gemini-3\.1-pro(?:$|[-:])/.test(model))
		) {
			thinkingConfig.thinkingLevel = 'low';
		}
	}

	return body;
};

const prepareGeminiBody = (body: any, model: string) => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
	body.safetySettings = minimumSafetySettings();
	return normalizeGemini3Body(ensureTrailingUserTurn(body, model), model);
};

const getGeminiModelFromPath = (pathname: string) => {
	const match = pathname.match(/\/models\/([^/:]+):(?:generateContent|streamGenerateContent)$/);
	return match?.[1];
};

/** A Durable Object's behavior is defined in an exported Javascript class */
export class LoadBalancer extends DurableObject {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Initialize the database schema upon first creation.
		this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS api_keys (api_key TEXT PRIMARY KEY)');
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS api_key_cooldowns (
				api_key TEXT PRIMARY KEY,
				cooldown_until INTEGER NOT NULL DEFAULT 0,
				failed_count INTEGER NOT NULL DEFAULT 0,
				last_error_status INTEGER
			)
		`);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return handleOPTIONS();
		}

		const url = new URL(request.url);
		const pathname = url.pathname;

		// Admin API routes
		if (pathname === '/api/keys' && request.method === 'POST') {
			return this.handleApiKeys(request);
		}
		if (pathname === '/api/keys' && request.method === 'GET') {
			return this.getAllApiKeys();
		}
		if (pathname === '/api/keys' && request.method === 'DELETE') {
			return this.handleDeleteApiKeys(request);
		}
		if (pathname === '/api/keys/check' && request.method === 'GET') {
			return this.handleApiKeysCheck();
		}

		const search = url.search;

		// OpenAI compatible routes
		if (
			pathname.endsWith('/chat/completions') ||
			pathname.endsWith('/completions') ||
			pathname.endsWith('/embeddings') ||
			pathname.endsWith('/models')
		) {
			return this.handleOpenAI(request);
		}

		// Direct Gemini proxy
		// The client's `key` is the relay AUTH_KEY. Never forward it to Google as a Gemini API key.
		const upstreamUrl = new URL(`${BASE_URL}${pathname}${search}`);
		upstreamUrl.searchParams.delete('key');
		const targetUrl = upstreamUrl.toString();

		try {
			const headers = new Headers();
			const apiKeys = await this.getRandomApiKeys(MAX_API_KEY_ATTEMPTS);
			if (apiKeys.length === 0) {
				return this.noAvailableKeysResponse();
			}

			// Forward content-type header
			if (request.headers.has('content-type')) {
				headers.set('content-type', request.headers.get('content-type')!);
			}

			console.log(`Request Sending to Gemini: ${targetUrl}`);

			let requestBody: BodyInit | null = request.body;
			const directModel = getGeminiModelFromPath(pathname);
			if (request.method === 'POST' && directModel) {
				const rawBody = await request.text();
				requestBody = rawBody;
				try {
					requestBody = JSON.stringify(prepareGeminiBody(JSON.parse(rawBody), directModel));
				} catch {
					// Keep the original body so Gemini can return its normal JSON validation error.
				}
			}

			const response = await this.fetchWithApiKeyRetry(targetUrl, request.method, headers, requestBody, apiKeys, Boolean(directModel));

			console.log('Call Gemini Success');

			const responseHeaders = new Headers(response.headers);
			responseHeaders.set('Access-Control-Allow-Origin', '*');
			responseHeaders.delete('transfer-encoding');
			responseHeaders.delete('connection');
			responseHeaders.delete('keep-alive');
			responseHeaders.delete('content-encoding');
			responseHeaders.set('Referrer-Policy', 'no-referrer');

			return new Response(response.body, {
				status: response.status,
				headers: responseHeaders,
			});
		} catch (error) {
			console.error('Failed to fetch:', error);
			return new Response('Internal Server Error\n' + error, {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	}

	async handleModels(apiKey: string) {
		const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
			headers: makeHeaders(apiKey),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { models } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: models.map(({ name }: any) => ({
						id: name.replace('models/', ''),
						object: 'model',
						created: 0,
						owned_by: '',
					})),
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async handleEmbeddings(req: any, apiKey: string) {
		const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-004';

		if (typeof req.model !== 'string') {
			throw new HttpError('model is not specified', 400);
		}

		let model;
		if (req.model.startsWith('models/')) {
			model = req.model;
		} else {
			if (!req.model.startsWith('gemini-')) {
				req.model = DEFAULT_EMBEDDINGS_MODEL;
			}
			model = 'models/' + req.model;
		}

		if (!Array.isArray(req.input)) {
			req.input = [req.input];
		}

		const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				requests: req.input.map((text: string) => ({
					model,
					content: { parts: { text } },
					outputDimensionality: req.dimensions,
				})),
			}),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { embeddings } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: embeddings.map(({ values }: any, index: number) => ({
						object: 'embedding',
						index,
						embedding: values,
					})),
					model: req.model,
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async handleCompletions(req: any, apiKeys: string[]) {
		const DEFAULT_MODEL = 'gemini-2.5-flash';
		let model = DEFAULT_MODEL;

		switch (true) {
			case typeof req.model !== 'string':
				break;
			case req.model.startsWith('models/'):
				model = req.model.substring(7);
				break;
			case req.model.startsWith('gemini-'):
			case req.model.startsWith('gemma-'):
			case req.model.startsWith('learnlm-'):
				model = req.model;
		}

		let body = await this.transformRequest(req, model);
		body = ensureTrailingUserTurn(body, model);
		const extra = req.extra_body?.google;

		if (extra) {
			if (extra.safety_settings) {
				body.safetySettings = extra.safety_settings;
			}
			if (extra.cached_content) {
				body.cachedContent = extra.cached_content;
			}
			if (extra.thinking_config) {
				body.generationConfig.thinkingConfig = extra.thinking_config;
			}
		}
		body = normalizeGemini3Body(body, model);

		switch (true) {
			case model.endsWith(':search'):
				model = model.substring(0, model.length - 7);
			case req.model.endsWith('-search-preview'):
			case req.tools?.some((tool: any) => tool.function?.name === 'googleSearch'):
				body.tools = body.tools || [];
				body.tools.push({ function_declarations: [{ name: 'googleSearch', parameters: {} }] });
		}

		const TASK = req.stream ? 'streamGenerateContent' : 'generateContent';
		let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
		if (req.stream) {
			url += '?alt=sse';
		}

		const response = await this.fetchWithApiKeyRetry(
			url,
			'POST',
			new Headers({ 'Content-Type': 'application/json', 'x-goog-api-client': API_CLIENT }),
			JSON.stringify(body),
			apiKeys,
			true
		);

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			let id = 'chatcmpl-' + this.generateId();
			const shared = {};

			if (req.stream) {
				responseBody = response
					.body!.pipeThrough(new TextDecoderStream())
					.pipeThrough(
						new TransformStream({
							transform: this.parseStream,
							flush: this.parseStreamFlush,
							buffer: '',
							shared,
						} as any)
					)
					.pipeThrough(
						new TransformStream({
							transform: this.toOpenAiStream,
							flush: this.toOpenAiStreamFlush,
							streamIncludeUsage: req.stream_options?.include_usage,
							model,
							id,
							last: [],
							shared,
						} as any)
					)
					.pipeThrough(new TextEncoderStream());
			} else {
				let body: any = await response.text();
				try {
					body = JSON.parse(body);
					if (!body.candidates) {
						throw new Error('Invalid completion object');
					}
				} catch (err) {
					console.error('Error parsing response:', err);
					return new Response(JSON.stringify({ error: 'Failed to parse response' }), {
						...fixCors(response),
						status: 500,
					});
				}
				responseBody = this.processCompletionsResponse(body, model, id);
			}
		}
		return new Response(responseBody, fixCors(response));
	}

	// 辅助方法
	private generateId(): string {
		const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
		return Array.from({ length: 29 }, randomChar).join('');
	}

	private async transformRequest(req: any, model: string) {
		return {
			...(await this.transformMessages(req.messages)),
			safetySettings: minimumSafetySettings(),
			generationConfig: this.transformConfig(req, model),
			...this.transformTools(req),
			cachedContent: undefined as any,
		};
	}

	private transformConfig(req: any, model: string) {
		const fieldsMap: Record<string, string> = {
			frequency_penalty: 'frequencyPenalty',
			max_completion_tokens: 'maxOutputTokens',
			max_tokens: 'maxOutputTokens',
			n: 'candidateCount',
			presence_penalty: 'presencePenalty',
			seed: 'seed',
			stop: 'stopSequences',
			temperature: 'temperature',
			top_k: 'topK',
			top_p: 'topP',
		};

		const thinkingBudgetMap: Record<string, number> = {
			low: 1024,
			medium: 8192,
			high: 24576,
		};

		let cfg: any = {};
		for (let key in req) {
			const matchedKey = fieldsMap[key];
			if (matchedKey) {
				cfg[matchedKey] = req[key];
			}
		}

		if (req.response_format) {
			switch (req.response_format.type) {
				case 'json_schema':
					cfg.responseSchema = req.response_format.json_schema?.schema;
					if (cfg.responseSchema && 'enum' in cfg.responseSchema) {
						cfg.responseMimeType = 'text/x.enum';
						break;
					}
				case 'json_object':
					cfg.responseMimeType = 'application/json';
					break;
				case 'text':
					cfg.responseMimeType = 'text/plain';
					break;
				default:
					throw new HttpError('Unsupported response_format.type', 400);
			}
		}
		if (req.reasoning_effort) {
			cfg.thinkingConfig = isGemini3Model(model)
				? { thinkingLevel: req.reasoning_effort }
				: { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
		}

		return cfg;
	}

	private async transformMessages(messages: any[]) {
		if (!messages) {
			return {};
		}

		const contents: any[] = [];
		let system_instruction;

		for (const item of messages) {
			switch (item.role) {
				case 'system':
					system_instruction = { parts: await this.transformMsg(item) };
					continue;
				case 'assistant':
					item.role = 'model';
					break;
				case 'user':
					break;
				default:
					throw new HttpError(`Unknown message role: "${item.role}"`, 400);
			}

			contents.push({
				role: item.role,
				parts: await this.transformMsg(item),
			});
		}

		return { system_instruction, contents };
	}

	private async transformMsg({ content }: any) {
		const parts = [];
		if (!Array.isArray(content)) {
			parts.push({ text: content });
			return parts;
		}

		for (const item of content) {
			switch (item.type) {
				case 'text':
					parts.push({ text: item.text });
					break;
				case 'image_url':
					// 简化的图片处理
					parts.push({ text: '[图片内容]' });
					break;
				default:
					throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
			}
		}

		return parts;
	}

	private transformTools(req: any) {
		let tools, tool_config;
		if (req.tools) {
			const funcs = req.tools.filter((tool: any) => tool.type === 'function' && tool.function?.name !== 'googleSearch');
			if (funcs.length > 0) {
				tools = [{ function_declarations: funcs.map((schema: any) => schema.function) }];
			}
		}
		if (req.tool_choice) {
			const allowed_function_names = req.tool_choice?.type === 'function' ? [req.tool_choice?.function?.name] : undefined;
			if (allowed_function_names || typeof req.tool_choice === 'string') {
				tool_config = {
					function_calling_config: {
						mode: allowed_function_names ? 'ANY' : req.tool_choice.toUpperCase(),
						allowed_function_names,
					},
				};
			}
		}
		return { tools, tool_config };
	}

	private processCompletionsResponse(data: any, model: string, id: string) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const transformCandidatesMessage = (cand: any) => {
			const message = { role: 'assistant', content: [] as string[] };
			for (const part of cand.content?.parts ?? []) {
				if (part.text) {
					message.content.push(part.text);
				}
			}

			return {
				index: cand.index || 0,
				message: {
					...message,
					content: message.content.join('') || null,
				},
				logprobs: null,
				finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
			};
		};

		const obj = {
			id,
			choices: data.candidates.map(transformCandidatesMessage),
			created: Math.floor(Date.now() / 1000),
			model: data.modelVersion ?? model,
			object: 'chat.completion',
			usage: data.usageMetadata && {
				completion_tokens: data.usageMetadata.candidatesTokenCount,
				prompt_tokens: data.usageMetadata.promptTokenCount,
				total_tokens: data.usageMetadata.totalTokenCount,
			},
		};

		return JSON.stringify(obj);
	}

	// 流处理方法
	private parseStream(this: any, chunk: string, controller: any) {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop()!;

		for (const line of lines) {
			if (line.startsWith('data: ')) {
				const data = line.substring(6);
				if (data.startsWith('{')) {
					controller.enqueue(JSON.parse(data));
				}
			}
		}
	}

	private parseStreamFlush(this: any, controller: any) {
		if (this.buffer) {
			try {
				controller.enqueue(JSON.parse(this.buffer));
			} catch (e) {
				console.error('Error parsing remaining buffer:', e);
			}
		}
	}

	private toOpenAiStream(this: any, line: any, controller: any) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const { candidates, usageMetadata } = line;
		if (usageMetadata) {
			this.shared.usage = {
				completion_tokens: usageMetadata.candidatesTokenCount,
				prompt_tokens: usageMetadata.promptTokenCount,
				total_tokens: usageMetadata.totalTokenCount,
			};
		}

		if (candidates) {
			for (const cand of candidates) {
				const { content, finishReason } = cand;
				const index = cand.index ?? 0;
				const parts = content?.parts ?? [];
				const text = parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('');

				if (this.last[index] === undefined) {
					this.last[index] = '';
				}

				const lastText = this.last[index] || '';
				let delta = '';

				if (text.startsWith(lastText)) {
					delta = text.substring(lastText.length);
				} else {
					// Find the common prefix
					let i = 0;
					while (i < text.length && i < lastText.length && text[i] === lastText[i]) {
						i++;
					}
					// Send the rest of the new text as delta.
					// This might not be perfect for all clients, but it prevents data loss.
					delta = text.substring(i);
				}

				this.last[index] = text;

				const obj = {
					id: this.id,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: this.model,
					choices: [
						{
							index,
							delta: { content: delta },
							finish_reason: reasonsMap[finishReason] || finishReason,
						},
					],
				};
				controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
			}
		}
	}

	private toOpenAiStreamFlush(this: any, controller: any) {
		if (this.streamIncludeUsage && this.shared.usage) {
			const obj = {
				id: this.id,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: this.model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: 'stop',
					},
				],
				usage: this.shared.usage,
			};
			controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
		}
		controller.enqueue('data: [DONE]\n\n');
	}
	// =================================================================================================
	// Admin API Handlers
	// =================================================================================================

	async handleApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			for (const key of keys) {
				await this.ctx.storage.sql.exec('INSERT OR IGNORE INTO api_keys (api_key) VALUES (?)', key);
			}

			return new Response(JSON.stringify({ message: 'API密钥添加成功。' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('处理API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleDeleteApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const placeholders = keys.map(() => '?').join(',');
			await this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE api_key IN (${placeholders})`, ...keys);
			await this.ctx.storage.sql.exec(`DELETE FROM api_key_cooldowns WHERE api_key IN (${placeholders})`, ...keys);

			return new Response(JSON.stringify({ message: 'API密钥删除成功。' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('删除API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleApiKeysCheck(): Promise<Response> {
		try {
			const results = await this.ctx.storage.sql.exec('SELECT api_key FROM api_keys').raw<any>();
			const keys = Array.from(results);

			const checkResults = await Promise.all(
				keys.map(async (key) => {
					try {
						const response = await fetch(`${BASE_URL}/${API_VERSION}/models?key=${key}`);
						return { key, valid: response.ok, error: response.ok ? null : await response.text() };
					} catch (e: any) {
						return { key, valid: false, error: e.message };
					}
				})
			);

			const invalidKeys = checkResults.filter((result) => !result.valid).map((result) => result.key);
			if (invalidKeys.length > 0) {
				const placeholders = invalidKeys.map(() => '?').join(', ');
				const statement = `DELETE FROM api_keys WHERE api_key IN (${placeholders})`;
				this.ctx.storage.sql.exec(statement, ...invalidKeys);
				this.ctx.storage.sql.exec(`DELETE FROM api_key_cooldowns WHERE api_key IN (${placeholders})`, ...invalidKeys);
				console.log(`移除了 ${invalidKeys.length} 个无效的API密钥。`);
			}

			return new Response(JSON.stringify(checkResults), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('检查API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async getAllApiKeys(): Promise<Response> {
		try {
			const results = await this.ctx.storage.sql.exec('SELECT * FROM api_keys').raw<any>();
			const keys = Array.from(results);
			return new Response(JSON.stringify({ keys }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('获取API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	// =================================================================================================
	// Helper Methods
	// =================================================================================================

	private async getRandomApiKeys(limit: number): Promise<string[]> {
		try {
			const results = await this.ctx.storage.sql
				.exec(
					`SELECT k.api_key
					 FROM api_keys k
					 LEFT JOIN api_key_cooldowns c ON c.api_key = k.api_key
					 WHERE COALESCE(c.cooldown_until, 0) <= ?
					 ORDER BY RANDOM()
					 LIMIT ?`,
					Date.now(),
					limit
				)
				.raw<any>();
			return Array.from(results)
				.map((row: any) => (Array.isArray(row) ? row[0] : row))
				.filter((key): key is string => typeof key === 'string' && key.length > 0);
		} catch (error) {
			console.error('获取随机API密钥失败:', error);
			return [];
		}
	}

	private async noAvailableKeysResponse(): Promise<Response> {
		const rows = Array.from(
			await this.ctx.storage.sql
				.exec(
					`SELECT COUNT(k.api_key), MIN(c.cooldown_until)
					 FROM api_keys k
					 LEFT JOIN api_key_cooldowns c ON c.api_key = k.api_key
					 WHERE c.cooldown_until > ?`,
					Date.now()
				)
				.raw<any>()
		);
		const [count = 0, earliestCooldown = 0] = (rows[0] as any[]) ?? [];
		if (Number(count) === 0) {
			return new Response('No API keys configured in the load balancer.', { status: 500 });
		}
		const retryAfter = Math.max(1, Math.ceil((Number(earliestCooldown) - Date.now()) / 1000));
		return new Response(JSON.stringify({ error: 'All API keys are cooling down.', retry_after: retryAfter }), {
			status: 429,
			headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
		});
	}

	private async fetchWithApiKeyRetry(
		url: string,
		method: string,
		baseHeaders: Headers,
		body: BodyInit | null,
		apiKeys: string[],
		retryEmptyCandidate = false
	): Promise<Response> {
		let lastError: unknown;
		for (let index = 0; index < apiKeys.length; index++) {
			const headers = new Headers(baseHeaders);
			headers.set('x-goog-api-key', apiKeys[index]);
			try {
				const response = await fetch(url, { method, headers, body });
				const emptyCandidate = retryEmptyCandidate && (await this.hasNoUsableCandidate(response));
				await this.updateKeyCooldown(apiKeys[index], response);
				const shouldRetry =
					(RETRYABLE_UPSTREAM_STATUSES.has(response.status) || emptyCandidate) && index < apiKeys.length - 1;
				if (!shouldRetry) return response;
				await response.body?.cancel();
			} catch (error) {
				lastError = error;
				if (index === apiKeys.length - 1) throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 250 * (index + 1)));
		}
		throw lastError instanceof Error ? lastError : new Error('All Gemini API key attempts failed.');
	}

	private async updateKeyCooldown(apiKey: string, response: Response): Promise<void> {
		if (response.ok) {
			await this.ctx.storage.sql.exec('DELETE FROM api_key_cooldowns WHERE api_key = ?', apiKey);
			return;
		}

		let cooldownMs = 0;
		if (response.status === 429) {
			cooldownMs = await this.get429CooldownMs(response);
		} else if (response.status === 401 || response.status === 403) {
			cooldownMs = INVALID_KEY_COOLDOWN_MS;
		}
		if (cooldownMs === 0) return;

		await this.ctx.storage.sql.exec(
			`INSERT INTO api_key_cooldowns (api_key, cooldown_until, failed_count, last_error_status)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(api_key) DO UPDATE SET
				cooldown_until = excluded.cooldown_until,
				failed_count = api_key_cooldowns.failed_count + 1,
				last_error_status = excluded.last_error_status`,
			apiKey,
			Date.now() + cooldownMs,
			response.status
		);
	}

	private async get429CooldownMs(response: Response): Promise<number> {
		const retryAfter = response.headers.get('retry-after');
		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
			const retryDate = Date.parse(retryAfter);
			if (Number.isFinite(retryDate) && retryDate > Date.now()) return retryDate - Date.now();
		}

		let errorText = '';
		try {
			errorText = await response.clone().text();
		} catch {
			return UNKNOWN_429_COOLDOWN_MS;
		}
		const retryDelay = errorText.match(/"(?:retryDelay|quotaResetDelay)"\s*:\s*"([0-9.]+)s"/i)?.[1];
		if (retryDelay) return Math.max(1000, Number(retryDelay) * 1000);
		if (/(per.?day|daily|requests.?per.?day|tokens.?per.?day|\bRPD\b|\bTPD\b)/i.test(errorText)) return INVALID_KEY_COOLDOWN_MS;
		if (/(per.?minute|requests.?per.?minute|tokens.?per.?minute|\bRPM\b|\bTPM\b)/i.test(errorText)) return MINUTE_COOLDOWN_MS;
		return UNKNOWN_429_COOLDOWN_MS;
	}

	private async hasNoUsableCandidate(response: Response): Promise<boolean> {
		if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
		try {
			const data: any = await response.clone().json();
			if (!Array.isArray(data?.candidates) || data.candidates.length === 0) return true;
			return !data.candidates.some((candidate: any) =>
				(candidate.content?.parts ?? []).some(
					(part: any) => (!part.thought && typeof part.text === 'string' && part.text.length > 0) || part.functionCall || part.inlineData
				)
			);
		} catch {
			return false;
		}
	}

	private async handleOpenAI(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		const assert = (success: Boolean) => {
			if (!success) {
				throw new HttpError('The specified HTTP method is not allowed for the requested resource', 400);
			}
		};
		const errHandler = (err: Error) => {
			console.error(err);
			return new Response(err.message, fixCors({ statusText: err.message ?? 'Internal Server Error', status: 500 }));
		};

		const apiKeys = await this.getRandomApiKeys(MAX_API_KEY_ATTEMPTS);
		if (apiKeys.length === 0) {
			return this.noAvailableKeysResponse();
		}

		switch (true) {
			case pathname.endsWith('/chat/completions'):
				assert(request.method === 'POST');
				return this.handleCompletions(await request.json(), apiKeys).catch(errHandler);
			case pathname.endsWith('/embeddings'):
				assert(request.method === 'POST');
				return this.handleEmbeddings(await request.json(), apiKeys[0]).catch(errHandler);
			case pathname.endsWith('/models'):
				assert(request.method === 'GET');
				return this.handleModels(apiKeys[0]).catch(errHandler);
			default:
				throw new HttpError('404 Not Found', 404);
		}
	}
}
