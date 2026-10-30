import { describe, expect, it } from 'vitest';
import type { ConversationMetadata } from '../src/mistral-conversation';
import { formatSearchResult, parseSearchQuery, streamWithSearch, type SearchResult } from '../src/web-search';

type Event = { data: Record<string, unknown> };

async function* stream(...events: Event['data'][]) {
	for (const data of events) yield { event: String(data.type), data } as never;
}

const started = (conversationId = 'conv_1') => ({ type: 'conversation.response.started', conversationId });
const text = (value: string) => ({ type: 'message.output.delta', content: value });
const call = (toolCallId: string, ...pieces: string[]) =>
	pieces.map((argumentsPiece) => ({ type: 'function.call.delta', toolCallId, name: 'search_web', arguments: argumentsPiece }));

function fakeClient(rounds: Event['data'][][]) {
	const appended: unknown[] = [];
	const client = {
		beta: {
			conversations: {
				appendStream: async (request: { conversationAppendStreamRequest: { inputs: unknown } }) => {
					appended.push(request.conversationAppendStreamRequest.inputs);
					return stream(...(rounds.shift() ?? []));
				},
			},
		},
	};
	return { client: client as never, appended };
}

async function collect(generator: AsyncGenerator<string>) {
	let out = '';
	for await (const chunk of generator) out += chunk;
	return out;
}

const result = (query: string): SearchResult => ({
	text: `- facts about ${query} [https://news.example/${query}]`,
	sources: [{ title: `About ${query}`, url: `https://news.example/${query}` }],
});

describe('streamWithSearch', () => {
	it('answers directly when the model needs no search', async () => {
		const { client, appended } = fakeClient([]);
		const out = await collect(streamWithSearch(client, stream(started(), text('Hello.')), () => undefined, { maxRounds: 2, maxSearchesPerRound: 2 }));
		expect(out).toBe('Hello.');
		expect(appended).toEqual([]);
	});

	it('runs searches, returns every result, and reports activity and sources', async () => {
		const { client, appended } = fakeClient([[started(), text('Mistral raised money.')]]);
		const metadata: ConversationMetadata[] = [];
		const queries: string[] = [];
		const out = await collect(
			streamWithSearch(client, stream(started(), ...call('a', '{"query": "mis', 'tral funding"}'), ...call('b', '{"query": "mistral news"}')), (m) => metadata.push(m), {
				maxRounds: 2,
				maxSearchesPerRound: 4,
				search: async (query) => {
					queries.push(query);
					return result(query.replace(' ', '-'));
				},
			}),
		);

		expect(out).toBe('Mistral raised money.');
		expect(queries).toEqual(['mistral funding', 'mistral news']);
		expect(appended).toHaveLength(1);
		expect((appended[0] as { toolCallId: string; result: string }[]).map((entry) => [entry.toolCallId, entry.result.includes('Sources:')])).toEqual([
			['a', true],
			['b', true],
		]);
		const tools = metadata.flatMap((m) => (m.tool ? [`${m.tool.id}:${m.tool.status}`] : []));
		expect(tools).toEqual(expect.arrayContaining(['a:running', 'a:complete', 'b:running', 'b:complete']));
		expect(metadata.filter((m) => m.sources).at(-1)?.sources?.map((s) => s.url)).toEqual(['https://news.example/mistral-funding', 'https://news.example/mistral-news']);
	});

	it('announces the first search out loud for voice turns', async () => {
		const { client } = fakeClient([[started(), text('Here it is.')]]);
		const out = await collect(
			streamWithSearch(client, stream(started(), ...call('a', '{"query": "x"}')), () => undefined, {
				maxRounds: 1,
				maxSearchesPerRound: 1,
				announceSearch: true,
				search: async (query) => result(query),
			}),
		);
		expect(out).toBe('Let me search for more current information. Here it is.');
	});

	it('caps searches per round and tells the model to stop after the last round', async () => {
		const { client, appended } = fakeClient([[started(), ...call('c', '{"query": "more"}')], [started(), text('Done.')]]);
		const queries: string[] = [];
		const out = await collect(
			streamWithSearch(client, stream(started(), ...call('a', '{"query": "one"}'), ...call('b', '{"query": "two"}')), () => undefined, {
				maxRounds: 1,
				maxSearchesPerRound: 1,
				search: async (query) => {
					queries.push(query);
					return result(query);
				},
			}),
		);
		expect(out).toBe('Done.');
		expect(queries).toEqual(['one']);
		const [first, second] = appended as { result: string }[][];
		expect(first[1].result).toMatch(/too many searches/);
		expect(second[0].result).toMatch(/No more searches/);
	});

	it('turns a failed search into a result instead of failing the turn', async () => {
		const { client, appended } = fakeClient([[started(), text('Answered anyway.')]]);
		const out = await collect(
			streamWithSearch(client, stream(started(), ...call('a', '{"query": "x"}')), () => undefined, {
				maxRounds: 1,
				maxSearchesPerRound: 1,
				search: async () => {
					throw new Error('rate limited');
				},
			}),
		);
		expect(out).toBe('Answered anyway.');
		expect((appended[0] as { result: string }[])[0].result).toMatch(/failed/);
	});
});

describe('parseSearchQuery', () => {
	it.each([
		['{"query": " mistral "}', 'mistral'],
		['{"query": ""}', null],
		['{"q": "x"}', null],
		['not json', null],
	])('reads %s', (args, query) => {
		expect(parseSearchQuery({ toolCallId: 'a', name: 'search_web', arguments: args })).toBe(query);
	});
});

describe('formatSearchResult', () => {
	it('appends sources and caps the length', () => {
		const formatted = formatSearchResult({ text: 'x'.repeat(5_000), sources: [{ title: 'A', url: 'https://a.example' }] });
		expect(formatted.length).toBe(4_000);
		expect(formatSearchResult({ text: 'Facts.', sources: [{ title: 'A', url: 'https://a.example' }] })).toBe('Facts.\n\nSources:\n- A: https://a.example');
	});
});
