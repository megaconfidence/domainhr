import { Mistral } from '@mistralai/mistralai';
import type { ConversationEvents, ConversationResponse } from '@mistralai/mistralai/models/components';

export type SourceReference = {
	title: string;
	url: string;
	description?: string;
};

export type ToolActivity = {
	id: string;
	name: string;
	status: 'running' | 'complete';
	arguments?: string;
};

export type ConversationMetadata = {
	conversationId?: string;
	sources?: SourceReference[];
	tool?: ToolActivity;
};

export type ConversationResult = {
	conversationId: string;
	text: string;
	sources: SourceReference[];
};

const SEARCH_RESULTS_PER_QUERY = 3;

export function createMistralClient(apiKey: string): Mistral {
	return new Mistral({ apiKey });
}

export function friendlyMistralError(error: unknown): string {
	if (isObject(error) && error.statusCode === 429) {
		return "I've reached Mistral's token limit for this minute. Wait about a minute, then try again.";
	}
	return 'I hit a problem reaching Mistral. Please try that question again.';
}

export function readConversationResponse(response: ConversationResponse): ConversationResult {
	const text: string[] = [];
	const sources: SourceReference[] = [];

	for (const output of response.outputs) {
		if (output.type !== 'message.output' || !('content' in output)) continue;
		readContent(output.content, text, sources);
	}

	return {
		conversationId: response.conversationId,
		text: text.join('').trim(),
		sources: dedupeSources(sources),
	};
}

export async function* readConversationStream(
	events: AsyncIterable<ConversationEvents>,
	onMetadata: (metadata: ConversationMetadata) => void,
	options: { announceSearch?: boolean } = {},
): AsyncGenerator<string> {
	const sources: SourceReference[] = [];
	const searchSources: SourceReference[] = [];
	const searchResults = new Map<string, SourceReference>();
	let responseText = '';
	let searchAnnounced = false;

	for await (const event of events) {
		const data = event.data;
		if (data.type === 'conversation.response.started') {
			onMetadata({ conversationId: data.conversationId });
			continue;
		}

		if (data.type === 'tool.execution.started') {
			onMetadata({
				tool: {
					id: data.id,
					name: String(data.name),
					status: 'running',
					arguments: data.arguments,
				},
			});
			if (options.announceSearch && !searchAnnounced && String(data.name).includes('web_search')) {
				searchAnnounced = true;
				yield 'Let me search for more current information. ';
			}
			continue;
		}

		if (data.type === 'tool.execution.done') {
			onMetadata({ tool: { id: data.id, name: String(data.name), status: 'complete' } });
			const results = readSearchResults(data.info);
			for (const result of results) searchResults.set(result.url, result);
			if (results.length) {
				searchSources.push(...results.slice(0, SEARCH_RESULTS_PER_QUERY));
				onMetadata({ sources: dedupeSources([...sources, ...searchSources]) });
			}
			continue;
		}

		if (data.type === 'conversation.response.error') {
			throw new Error(`Mistral conversation failed (${data.code}): ${data.message}`);
		}

		if (data.type !== 'message.output.delta') continue;
		const text: string[] = [];
		const sourceCount = sources.length;
		readContent(data.content, text, sources);
		if (sources.length > sourceCount) onMetadata({ sources: dedupeSources([...sources, ...searchSources]) });
		for (const chunk of text) {
			if (!chunk) continue;
			responseText += chunk;
			yield chunk;
		}
	}

	const cited = citedSources(responseText, searchResults);
	if (cited.length) onMetadata({ sources: dedupeSources([...cited, ...sources, ...searchSources]) });
}

export function dedupeSources(sources: SourceReference[]): SourceReference[] {
	const seen = new Set<string>();
	return sources.filter((source) => {
		if (!source.url || seen.has(source.url)) return false;
		seen.add(source.url);
		return true;
	});
}

function readContent(content: unknown, text: string[], sources: SourceReference[]): void {
	if (typeof content === 'string') {
		text.push(content);
		return;
	}

	if (Array.isArray(content)) {
		for (const chunk of content) readContent(chunk, text, sources);
		return;
	}

	if (!isObject(content)) return;
	if ((content.type === 'text' || content.type === undefined) && typeof content.text === 'string') {
		text.push(content.text);
	}
	if (content.type === 'tool_reference' && typeof content.title === 'string' && typeof content.url === 'string') {
		sources.push({
			title: content.title,
			url: content.url,
			...(typeof content.description === 'string' ? { description: content.description } : {}),
		});
	}
}

function readSearchResults(info: unknown): SourceReference[] {
	if (!isObject(info) || typeof info.result !== 'string') return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(info.result);
	} catch {
		return [];
	}
	if (!isObject(parsed)) return [];
	return Object.values(parsed).flatMap((result) =>
		isObject(result) && typeof result.url === 'string' && typeof result.title === 'string'
			? [{ title: result.title, url: result.url }]
			: [],
	);
}

function citedSources(text: string, searchResults: Map<string, SourceReference>): SourceReference[] {
	return [...text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map(
		([, label, url]) => searchResults.get(url) ?? { title: label, url },
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
