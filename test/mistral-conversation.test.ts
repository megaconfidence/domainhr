import { describe, expect, it } from 'vitest';
import type { ConversationResponse } from '@mistralai/mistralai/models/components';
import { dedupeSources, friendlyMistralError, readConversationResponse, readConversationStream } from '../src/mistral-conversation';

describe('readConversationResponse', () => {
	it('collects text and source references from a response', () => {
		const response = {
			object: 'conversation.response',
			conversationId: 'conversation-1',
			outputs: [
				{
					type: 'message.output',
					content: [
						{ type: 'text', text: 'A clear answer.' },
						{ type: 'tool_reference', tool: 'web_search_premium', title: 'Product docs', url: 'https://example.com/docs' },
					],
				},
			],
			usage: {},
		} as ConversationResponse;

		expect(readConversationResponse(response)).toEqual({
			conversationId: 'conversation-1',
			text: 'A clear answer.',
			sources: [{ title: 'Product docs', url: 'https://example.com/docs' }],
		});
	});

	it('surfaces streamed conversation errors', async () => {
		async function* events() {
			yield {
				event: 'conversation.response.error',
				data: { type: 'conversation.response.error', code: 500, message: 'Search failed' },
			};
		}

		const consume = async () => {
			for await (const chunk of readConversationStream(events() as never, () => undefined)) void chunk;
		};

		await expect(consume()).rejects.toThrow('Search failed');
	});

	it('reports search results and cited links as sources', async () => {
		async function* events() {
			yield {
				event: 'tool.execution.done',
				data: {
					type: 'tool.execution.done',
					id: 'tool-1',
					name: 'web_search_premium',
					outputIndex: 0,
					info: {
						result: JSON.stringify({
							'search-result://a': { url: 'https://example.com/news', title: 'Example launches a product', description: '<b>x</b>' },
							'search-result://b': { url: 'https://example.com/unused', title: 'Not cited' },
						}),
					},
				},
			};
			yield {
				event: 'message.output.delta',
				data: { type: 'message.output.delta', content: 'It launched [a product](https://example.com/' },
			};
			yield {
				event: 'message.output.delta',
				data: { type: 'message.output.delta', content: 'news) and [docs](https://docs.example.com/start).' },
			};
		}

		const metadata: Array<{ sources?: unknown }> = [];
		for await (const chunk of readConversationStream(events() as never, (value) => metadata.push(value))) void chunk;

		expect(metadata[1]).toEqual({
			sources: [
				{ title: 'Example launches a product', url: 'https://example.com/news' },
				{ title: 'Not cited', url: 'https://example.com/unused' },
			],
		});
		expect(metadata.at(-1)).toEqual({
			sources: [
				{ title: 'Example launches a product', url: 'https://example.com/news' },
				{ title: 'docs', url: 'https://docs.example.com/start' },
				{ title: 'Not cited', url: 'https://example.com/unused' },
			],
		});
	});

	it('surfaces tool activity and announces live searches', async () => {
		async function* events() {
			yield {
				event: 'tool.execution.started',
				data: {
					type: 'tool.execution.started',
					id: 'tool-1',
					name: 'web_search_premium',
					arguments: '{"query":"latest news"}',
					outputIndex: 0,
				},
			};
			yield {
				event: 'tool.execution.done',
				data: { type: 'tool.execution.done', id: 'tool-1', name: 'web_search_premium', outputIndex: 0 },
			};
		}

		const metadata: unknown[] = [];
		const text: string[] = [];
		for await (const chunk of readConversationStream(events() as never, (value) => metadata.push(value), { announceSearch: true })) {
			text.push(chunk);
		}

		expect(text.join('')).toContain('Let me search');
		expect(metadata).toEqual([
			{
				tool: {
					id: 'tool-1',
					name: 'web_search_premium',
					status: 'running',
					arguments: '{"query":"latest news"}',
				},
			},
			{ tool: { id: 'tool-1', name: 'web_search_premium', status: 'complete' } },
		]);
	});

	it('returns a useful token-rate-limit message', () => {
		expect(friendlyMistralError({ statusCode: 429 })).toContain('token limit');
	});
});

describe('dedupeSources', () => {
	it('keeps the first source for each URL', () => {
		expect(
			dedupeSources([
				{ title: 'First', url: 'https://example.com' },
				{ title: 'Duplicate', url: 'https://example.com' },
			]),
		).toEqual([{ title: 'First', url: 'https://example.com' }]);
	});
});
