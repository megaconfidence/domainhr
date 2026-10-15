import { useEffect, useState, useSyncExternalStore } from 'react';

// @cloudflare/voice reports `status` from the server, which flips to "listening"
// as soon as the agent finishes streaming audio, while the browser may still be
// playing the queued speech. The SDK keeps its playback state private, so we
// observe it directly: the voice client is the only code in this app that plays
// audio through AudioBufferSourceNode, one node per chunk.
const activeSources = new Set<AudioBufferSourceNode>();
const listeners = new Set<() => void>();

function notify() {
	for (const listener of listeners) listener();
}

if (typeof AudioBufferSourceNode !== 'undefined') {
	const start = AudioBufferSourceNode.prototype.start;
	AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<AudioBufferSourceNode['start']>) {
		activeSources.add(this);
		this.addEventListener(
			'ended',
			() => {
				activeSources.delete(this);
				notify();
			},
			{ once: true },
		);
		notify();
		return start.apply(this, args);
	};
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

const getSnapshot = () => activeSources.size > 0;

/** True while assistant speech is audible, bridging tiny gaps between audio chunks. */
export function useAssistantAudible(holdMs = 300): boolean {
	const playing = useSyncExternalStore(subscribe, getSnapshot, () => false);
	const [audible, setAudible] = useState(playing);

	useEffect(() => {
		if (playing) {
			setAudible(true);
			return;
		}
		const timeout = setTimeout(() => setAudible(false), holdMs);
		return () => clearTimeout(timeout);
	}, [playing, holdMs]);

	return audible;
}
