import type { StreamingTTSProvider, TTSProvider, Transcriber, TranscriberSession, TranscriberSessionOptions } from '@cloudflare/voice';
import { debugLog, textPreview } from './debug';

const REALTIME_URL = 'https://api.mistral.ai/v1/audio/transcriptions/realtime';
const SPEECH_URL = 'https://api.mistral.ai/v1/audio/speech';
const STT_MODEL = 'voxtral-mini-transcribe-realtime-3';
const FALLBACK_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
const DEFAULT_VOICE = 'gb_jane_neutral';
export const TTS_SAMPLE_RATE = 24_000;
const SAMPLE_RATE = 16_000;
const STREAMING_DELAY_MS = 480;
const TURN_DETECTION = {
	start_threshold: 0.8,
	eager_end_threshold: 0.4,
	end_threshold: 0.2,
	min_silence_ms: 500,
	end_timeout_ms: 5_600,
};
const SILENCE_THRESHOLD = 0.01;
const ENDPOINT_SILENCE_MS = 1_200;
const SETTLE_AFTER_DELTA_MS = 250;
const MAX_FINALIZE_WAIT_MS = 6_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_PENDING_BYTES = 960_000;

type MistralRealtimeSTTOptions = {
	apiKey: string;
	contextBias?: () => string[];
};

type MistralTTSOptions = {
	apiKey: string;
	model: string;
	voice?: string;
};

export class MistralRealtimeSTT implements Transcriber {
	constructor(private readonly providerOptions: MistralRealtimeSTTOptions) {}

	createSession(options?: TranscriberSessionOptions): TranscriberSession {
		return new MistralRealtimeSession(this.providerOptions, options);
	}
}

class MistralRealtimeSession implements TranscriberSession {
	private websocket: WebSocket | null = null;
	private closed = false;
	private connected = false;
	private pendingChunks: ArrayBuffer[] = [];
	private pendingBytes = 0;
	private transcript = '';
	private turnDetection = true;
	private speechActive = false;
	private silenceMs = 0;
	private finalizing = false;
	private finalizeStartedAt = 0;
	private fatalReported = false;
	private commitTimer: ReturnType<typeof setTimeout> | null = null;
	private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly ready: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private readySettled = false;

	constructor(
		private readonly providerOptions: MistralRealtimeSTTOptions,
		private readonly sessionOptions?: TranscriberSessionOptions,
	) {
		this.ready = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.ready.catch(() => undefined);
		this.handshakeTimer = setTimeout(() => {
			const error = new Error('Voxtral realtime connection timed out.');
			this.rejectReadiness(error);
			this.reportFatal(error);
			this.close();
		}, HANDSHAKE_TIMEOUT_MS);
		void this.connect();
	}

	waitUntilReady(): Promise<void> {
		return this.ready;
	}

	feed(chunk: ArrayBuffer): void {
		if (this.closed) return;

		if (this.connected && this.websocket) {
			this.sendAudio(chunk);
		} else if (this.pendingBytes + chunk.byteLength <= MAX_PENDING_BYTES) {
			this.pendingChunks.push(chunk);
			this.pendingBytes += chunk.byteLength;
		}

		if (!this.turnDetection) this.detectSpeechBoundary(chunk);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.commitTimer) clearTimeout(this.commitTimer);
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.rejectReadiness(new Error('Voxtral realtime session ended before it was ready.'));
		this.pendingChunks = [];
		this.pendingBytes = 0;

		try {
			this.websocket?.send(JSON.stringify({ type: 'input_audio.end' }));
			this.websocket?.close(1000, 'Call ended');
		} catch {
			// The socket may already have closed while the call was ending.
		}
		this.websocket = null;
		this.connected = false;
	}

	private async connect(): Promise<void> {
		try {
			let { websocket, status } = await this.openSocket(STT_MODEL);
			if (!websocket && !this.closed) {
				debugLog('stt', 'fallback_model', { model: STT_MODEL, status, fallback: FALLBACK_STT_MODEL });
				this.turnDetection = false;
				({ websocket, status } = await this.openSocket(FALLBACK_STT_MODEL));
			}
			if (!websocket) throw new Error(`Voxtral realtime connection failed (${status}).`);
			if (this.closed) {
				websocket.accept();
				websocket.close(1000, 'Call ended');
				return;
			}

			websocket.accept();
			this.websocket = websocket;
			websocket.addEventListener('message', (event) => this.handleMessage(event));
			websocket.addEventListener('close', () => {
				this.connected = false;
				if (this.closed) return;
				const error = new Error('Voxtral realtime connection closed unexpectedly.');
				this.rejectReadiness(error);
				this.reportFatal(error);
			});
			websocket.addEventListener('error', () => {
				const error = new Error('Voxtral realtime connection failed.');
				this.rejectReadiness(error);
				this.reportFatal(error);
			});
		} catch (error) {
			this.rejectReadiness(toError(error));
			this.reportFatal(toError(error));
		}
	}

	private async openSocket(model: string): Promise<{ websocket?: WebSocket; status: number }> {
		const url = new URL(REALTIME_URL);
		url.searchParams.set('model', model);
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.providerOptions.apiKey}`,
				Upgrade: 'websocket',
			},
		});
		return { websocket: (response as Response & { webSocket?: WebSocket }).webSocket ?? undefined, status: response.status };
	}

	private handleMessage(event: MessageEvent): void {
		if (this.closed || typeof event.data !== 'string') return;

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(event.data) as Record<string, unknown>;
		} catch {
			return;
		}

		if (data.type === 'session.created') {
			const contextBias = this.turnDetection ? (this.providerOptions.contextBias?.() ?? []) : [];
			this.websocket?.send(
				JSON.stringify({
					type: 'session.update',
					session: {
						audio_format: { encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
						target_streaming_delay_ms: STREAMING_DELAY_MS,
						...(this.turnDetection ? { turn_detection: TURN_DETECTION } : {}),
						...(contextBias.length ? { context_bias: contextBias } : {}),
					},
				}),
			);
			return;
		}

		if (data.type === 'session.updated') {
			this.connected = true;
			debugLog('stt', 'session_ready', { targetStreamingDelayMs: STREAMING_DELAY_MS, turnDetection: this.turnDetection });
			for (const chunk of this.pendingChunks) this.sendAudio(chunk);
			this.pendingChunks = [];
			this.pendingBytes = 0;
			this.resolveReadiness();
			return;
		}

		if (data.type === 'transcription.text.delta' && typeof data.text === 'string') {
			this.transcript += data.text;
			this.sessionOptions?.onInterim?.(this.transcript.trim());
			if (this.finalizing) this.scheduleCommit();
			return;
		}

		if (data.type === 'turn.start') {
			this.finalizing = false;
			if (this.commitTimer) clearTimeout(this.commitTimer);
			this.commitTimer = null;
			this.sessionOptions?.onSpeechStart?.(this.transcript.trim() || undefined);
			return;
		}

		if (data.type === 'turn.end') {
			debugLog('stt', 'turn_end', { timeS: data.time_s, endReason: data.end_reason });
			this.finishTurn();
			return;
		}

		if (data.type === 'error') {
			const message = isObject(data.error) && typeof data.error.message === 'string' ? data.error.message : 'Voxtral transcription failed.';
			const error = new Error(message);
			this.rejectReadiness(error);
			this.reportFatal(error);
		}
	}

	private detectSpeechBoundary(chunk: ArrayBuffer): void {
		const durationMs = (chunk.byteLength / 2 / SAMPLE_RATE) * 1000;
		if (pcmRms(chunk) >= SILENCE_THRESHOLD) {
			if (!this.speechActive) {
				this.speechActive = true;
				this.finalizing = false;
				if (this.commitTimer) clearTimeout(this.commitTimer);
				this.commitTimer = null;
				this.sessionOptions?.onSpeechStart?.(this.transcript.trim() || undefined);
			}
			this.silenceMs = 0;
			return;
		}

		if (!this.speechActive || this.finalizing) return;
		this.silenceMs += durationMs;
		if (this.silenceMs >= ENDPOINT_SILENCE_MS) {
			this.speechActive = false;
			this.silenceMs = 0;
			this.finishTurn();
		}
	}

	private finishTurn(): void {
		this.finalizing = true;
		this.finalizeStartedAt = Date.now();
		this.websocket?.send(JSON.stringify({ type: 'input_audio.flush' }));
		this.scheduleCommit();
	}

	private scheduleCommit(): void {
		if (this.commitTimer) clearTimeout(this.commitTimer);
		this.commitTimer = setTimeout(() => this.commitUtterance(), SETTLE_AFTER_DELTA_MS);
	}

	private commitUtterance(): void {
		this.commitTimer = null;
		const text = this.transcript.trim();
		if (!text && Date.now() - this.finalizeStartedAt < MAX_FINALIZE_WAIT_MS) {
			this.scheduleCommit();
			return;
		}

		this.finalizing = false;
		this.transcript = '';
		if (text) {
			debugLog('stt', 'utterance_committed', { characters: text.length, preview: textPreview(text) });
			this.sessionOptions?.onUtterance?.(text);
		}
	}

	private sendAudio(chunk: ArrayBuffer): void {
		try {
			this.websocket?.send(JSON.stringify({ type: 'input_audio.append', audio: arrayBufferToBase64(chunk) }));
		} catch (error) {
			this.reportFatal(toError(error));
		}
	}

	private resolveReadiness(): void {
		if (this.readySettled) return;
		this.readySettled = true;
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = null;
		this.resolveReady();
	}

	private rejectReadiness(error: Error): void {
		if (this.readySettled) return;
		this.readySettled = true;
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = null;
		this.rejectReady(error);
	}

	private reportFatal(error: Error): void {
		if (this.closed || this.fatalReported) return;
		this.fatalReported = true;
		debugLog('stt', 'fatal_error', { message: error.message });
		this.sessionOptions?.onFatalError?.(error);
	}
}

export class MistralTTS implements TTSProvider, StreamingTTSProvider {
	constructor(private readonly options: MistralTTSOptions) {}

	async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
		try {
			const response = await fetch(SPEECH_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.options.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: this.options.model,
					input: text,
					response_format: 'pcm',
					stream: false,
					voice: this.voice,
				}),
				signal,
			});
			if (!response.ok) {
				const detail = (await response.text()).slice(0, 300);
				throw new Error(`Mistral TTS failed (${response.status})${detail ? `: ${detail}` : '.'}`);
			}
			const data = (await response.json()) as { audio_data?: string };
			if (!data.audio_data) throw new Error('Mistral TTS returned no audio.');
			return float32ToPcm16(base64ToArrayBuffer(data.audio_data));
		} catch (error) {
			if (signal?.aborted) return null;
			throw toError(error);
		}
	}

	async *synthesizeStream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer> {
		const response = await fetch(SPEECH_URL, {
			method: 'POST',
			headers: {
				Accept: 'text/event-stream',
				Authorization: `Bearer ${this.options.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: this.options.model,
				input: text,
				response_format: 'pcm',
				stream: true,
				voice: this.voice,
			}),
			signal,
		});

		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300);
			throw new Error(`Mistral streaming TTS failed (${response.status})${detail ? `: ${detail}` : '.'}`);
		}
		if (!response.body) throw new Error('Mistral streaming TTS returned no response body.');

		const converter = new Float32ToPcm16Stream();
		for await (const audio of parseSpeechAudioStream(response.body)) {
			if (signal?.aborted) return;
			const pcm = converter.push(audio);
			if (pcm.byteLength) yield pcm;
		}
	}

	private get voice(): string {
		return this.options.voice || DEFAULT_VOICE;
	}
}

export async function* parseSpeechAudioStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ArrayBuffer> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const events = buffer.split(/\r?\n\r?\n/);
		buffer = events.pop() ?? '';
		for (const event of events) {
			const audio = parseSpeechEvent(event);
			if (audio) yield audio;
		}
		if (done) break;
	}

	if (buffer.trim()) {
		const audio = parseSpeechEvent(buffer);
		if (audio) yield audio;
	}
}

function parseSpeechEvent(event: string): ArrayBuffer | null {
	const data = event
		.split(/\r?\n/)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trimStart())
		.join('\n');
	if (!data || data === '[DONE]') return null;

	try {
		const parsed = JSON.parse(data) as Record<string, unknown>;
		const payload = isObject(parsed.data) ? parsed.data : parsed;
		const audioData =
			typeof payload.audio_data === 'string' ? payload.audio_data : typeof payload.audioData === 'string' ? payload.audioData : null;
		return audioData ? base64ToArrayBuffer(audioData) : null;
	} catch {
		return null;
	}
}

class Float32ToPcm16Stream {
	private remainder = new Uint8Array(0);

	push(chunk: ArrayBuffer): ArrayBuffer {
		const bytes = new Uint8Array(this.remainder.byteLength + chunk.byteLength);
		bytes.set(this.remainder);
		bytes.set(new Uint8Array(chunk), this.remainder.byteLength);
		const usable = bytes.byteLength - (bytes.byteLength % 4);
		this.remainder = bytes.slice(usable);
		return float32ToPcm16(bytes.buffer.slice(0, usable));
	}
}

function float32ToPcm16(buffer: ArrayBuffer): ArrayBuffer {
	const view = new DataView(buffer);
	const pcm = new Int16Array(Math.floor(buffer.byteLength / 4));
	for (let index = 0; index < pcm.length; index++) {
		const sample = Math.max(-1, Math.min(1, view.getFloat32(index * 4, true)));
		pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}
	return pcm.buffer;
}

function pcmRms(buffer: ArrayBuffer): number {
	const samples = new Int16Array(buffer);
	if (samples.length === 0) return 0;
	let sum = 0;
	for (const sample of samples) {
		const normalized = sample / 32768;
		sum += normalized * normalized;
	}
	return Math.sqrt(sum / samples.length);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
