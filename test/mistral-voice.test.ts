import { afterEach, describe, expect, it, vi } from 'vitest';
import { MistralRealtimeSTT, MistralTTS, TTS_SAMPLE_RATE, parseSpeechAudioStream } from '../src/mistral-voice';

afterEach(() => {
	vi.unstubAllGlobals();
});

const float32Base64 = (...samples: number[]) => Buffer.from(new Float32Array(samples).buffer).toString('base64');

describe('MistralTTS', () => {
	it('requests 24 kHz PCM with the v3 voice field and converts it to 16-bit', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ audio_data: float32Base64(0.5, -0.5, 2) }))
			.mockResolvedValueOnce(Response.json({ audio_data: float32Base64(0) }));
		vi.stubGlobal('fetch', fetchMock);

		const tts = new MistralTTS({ apiKey: 'test-key', model: 'voxtral-mini-tts-3' });
		expect([...new Int16Array((await tts.synthesize('Hello'))!)]).toEqual([16383, -16384, 32767]);
		await new MistralTTS({ apiKey: 'test-key', model: 'voxtral-mini-tts-3', voice: 'custom-voice' }).synthesize('Again');

		expect(TTS_SAMPLE_RATE).toBe(24_000);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
			model: 'voxtral-mini-tts-3',
			input: 'Hello',
			response_format: 'pcm',
			stream: false,
			voice: 'gb_jane_neutral',
		});
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ voice: 'custom-voice' });
	});

	it('streams PCM deltas, keeping samples intact across chunk boundaries', async () => {
		const bytes = Buffer.from(new Float32Array([0.25, -1, 1]).buffer);
		const delta = (part: Buffer) => [
			'event: speech.audio.delta',
			`data: {"type":"speech.audio.delta","audio_data":"${part.toString('base64')}"}`,
			'',
		];
		const sse = [
			...delta(bytes.subarray(0, 6)),
			...delta(bytes.subarray(6)),
			'event: speech.audio.done',
			'data: {"type":"speech.audio.done","usage":{}}',
			'',
		].join('\n');
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
		vi.stubGlobal('fetch', fetchMock);

		const tts = new MistralTTS({ apiKey: 'test-key', model: 'voxtral-mini-tts-3' });
		const chunks: number[][] = [];
		for await (const chunk of tts.synthesizeStream('Hello')) chunks.push([...new Int16Array(chunk)]);

		expect(chunks).toEqual([[8191], [-32768, 32767]]);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
			stream: true,
			response_format: 'pcm',
			voice: 'gb_jane_neutral',
		});
	});
});

class FakeSocket {
	sent: Record<string, unknown>[] = [];
	private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

	accept(): void {}
	close(): void {}
	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}
	addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	receive(message: Record<string, unknown>): void {
		for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(message) });
	}
}

async function openSession(contextBias?: () => string[]) {
	const socket = new FakeSocket();
	const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({ status: 101, webSocket: socket } as unknown as Response);
	vi.stubGlobal('fetch', fetchMock);
	const callbacks = { onSpeechStart: vi.fn(), onInterim: vi.fn(), onUtterance: vi.fn(), onFatalError: vi.fn() };
	const session = new MistralRealtimeSTT({ apiKey: 'test-key', contextBias }).createSession(callbacks);
	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
	await Promise.resolve();
	return { socket, session, callbacks, fetchMock };
}

describe('MistralRealtimeSTT', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('configures a v3 session with turn detection and context bias', async () => {
		const { socket, session, fetchMock } = await openSession(() => ['mistral.ai', 'Mistral']);
		expect(String(fetchMock.mock.calls[0][0])).toContain('model=voxtral-mini-transcribe-realtime-3');

		socket.receive({ type: 'session.created' });
		expect(socket.sent[0]).toEqual({
			type: 'session.update',
			session: {
				audio_format: { encoding: 'pcm_s16le', sample_rate: 16_000 },
				target_streaming_delay_ms: 480,
				turn_detection: { start_threshold: 0.8, eager_end_threshold: 0.4, end_threshold: 0.2, min_silence_ms: 500, end_timeout_ms: 5_600 },
				context_bias: ['mistral.ai', 'Mistral'],
			},
		});

		socket.receive({ type: 'session.updated' });
		await expect(session.waitUntilReady!()).resolves.toBeUndefined();
		session.close();
	});

	it('omits context bias when there is none', async () => {
		const { socket, session } = await openSession(() => []);
		socket.receive({ type: 'session.created' });
		expect(socket.sent[0].session).not.toHaveProperty('context_bias');
		session.close();
	});

	it('commits an utterance shortly after the model signals end of turn', async () => {
		const { socket, session, callbacks } = await openSession();
		vi.useFakeTimers();
		socket.receive({ type: 'session.created' });
		socket.receive({ type: 'session.updated' });

		socket.receive({ type: 'turn.start', time_s: 0.4 });
		expect(callbacks.onSpeechStart).toHaveBeenCalledTimes(1);
		socket.receive({ type: 'transcription.text.delta', text: 'What does' });
		socket.receive({ type: 'transcription.text.delta', text: ' Mistral sell?' });
		expect(callbacks.onInterim).toHaveBeenLastCalledWith('What does Mistral sell?');

		socket.receive({ type: 'turn.end', time_s: 2.1, end_reason: 'threshold' });
		expect(socket.sent.at(-1)).toEqual({ type: 'input_audio.flush' });
		expect(callbacks.onUtterance).not.toHaveBeenCalled();

		vi.advanceTimersByTime(250);
		expect(callbacks.onUtterance).toHaveBeenCalledWith('What does Mistral sell?');
		session.close();
	});

	it('fails fast when Voxtral reports an error during setup', async () => {
		const { socket, session } = await openSession();
		socket.receive({ type: 'session.created' });
		socket.receive({ type: 'error', error: { message: 'Model is not available' } });
		await expect(session.waitUntilReady!()).rejects.toThrow('Model is not available');
		session.close();
	});

	it('falls back to the previous realtime model with silence endpointing when v3 is refused', async () => {
		const socket = new FakeSocket();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce({ status: 403 } as unknown as Response)
			.mockResolvedValueOnce({ status: 101, webSocket: socket } as unknown as Response);
		vi.stubGlobal('fetch', fetchMock);
		const callbacks = { onSpeechStart: vi.fn(), onInterim: vi.fn(), onUtterance: vi.fn(), onFatalError: vi.fn() };
		const session = new MistralRealtimeSTT({ apiKey: 'test-key', contextBias: () => ['mistral.ai'] }).createSession(callbacks);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		expect(String(fetchMock.mock.calls[1][0])).toContain('model=voxtral-mini-transcribe-realtime-2602');

		vi.useFakeTimers();
		socket.receive({ type: 'session.created' });
		expect(socket.sent[0]).toEqual({
			type: 'session.update',
			session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16_000 }, target_streaming_delay_ms: 480 },
		});
		socket.receive({ type: 'session.updated' });
		await expect(session.waitUntilReady!()).resolves.toBeUndefined();

		const tenthOfASecond = (amplitude: number) => new Int16Array(1_600).fill(amplitude).buffer;
		session.feed(tenthOfASecond(8_000));
		expect(callbacks.onSpeechStart).toHaveBeenCalledTimes(1);
		socket.receive({ type: 'transcription.text.delta', text: 'Who are their competitors?' });
		for (let i = 0; i < 12; i++) session.feed(tenthOfASecond(0));
		expect(socket.sent.at(-1)).toEqual({ type: 'input_audio.flush' });

		vi.advanceTimersByTime(250);
		expect(callbacks.onUtterance).toHaveBeenCalledWith('Who are their competitors?');
		expect(callbacks.onFatalError).not.toHaveBeenCalled();
		session.close();
	});

	it('keeps the turn open when speech resumes before the commit', async () => {
		const { socket, session, callbacks } = await openSession();
		vi.useFakeTimers();
		socket.receive({ type: 'session.created' });
		socket.receive({ type: 'session.updated' });

		socket.receive({ type: 'transcription.text.delta', text: 'Tell me about' });
		socket.receive({ type: 'turn.end', time_s: 1.2, end_reason: 'threshold' });
		socket.receive({ type: 'turn.start', time_s: 1.3 });
		vi.advanceTimersByTime(1_000);
		expect(callbacks.onUtterance).not.toHaveBeenCalled();

		socket.receive({ type: 'transcription.text.delta', text: ' their pricing' });
		socket.receive({ type: 'turn.end', time_s: 2.4, end_reason: 'threshold' });
		vi.advanceTimersByTime(250);
		expect(callbacks.onUtterance).toHaveBeenCalledWith('Tell me about their pricing');
		session.close();
	});
});

describe('parseSpeechAudioStream', () => {
	it('handles SSE events split across network chunks', async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('event: speech.audio.delta\ndata: {"type":"speech.audio.delta",'));
				controller.enqueue(encoder.encode('"audio_data":"BQY="}\n\n'));
				controller.close();
			},
		});
		const chunks: number[][] = [];
		for await (const chunk of parseSpeechAudioStream(stream)) chunks.push([...new Uint8Array(chunk)]);
		expect(chunks).toEqual([[5, 6]]);
	});
});
