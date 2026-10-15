import { useVoiceAgent } from '@cloudflare/voice/react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Mascot, MascotMood, PixelIcon, PixelLogo, PixelSpinner, PixelWaves } from './pixels';
import { useAssistantAudible } from './playback';

const REPO_URL = 'https://github.com/megaconfidence/domainhr';

const SUGGESTIONS = ['mistral.ai', 'cloudflare.com', 'huggingface.co'];

const LOADING_QUIPS = [
	'Skipping the cookie banner…',
	'Reading the fine print…',
	'Translating the buzzwords…',
	'Checking the About page twice…',
	'Asking the internet around…',
	'Figuring out who pays them…',
	'Decoding “synergy”…',
];

const BUBBLE_BARS = [0.55, 0.85, 1, 0.75, 0.45];

type Source = {
	title: string;
	url: string;
	description?: string;
};

type ToolActivity = {
	id: string;
	name: string;
	status: 'running' | 'complete';
	arguments?: string;
};

type ResearchStage = 'idle' | 'reading' | 'searching' | 'ready' | 'error';

type StepStatus = 'pending' | 'running' | 'complete';

type CustomMessage =
	| { type: 'research_status'; stage: 'reading' | 'searching'; message: string }
	| { type: 'research_complete'; domain: string; summary: string; sources: Source[] }
	| { type: 'research_error'; message: string }
	| { type: 'sources'; sources: Source[] }
	| { type: 'tool_call'; tool: ToolActivity }
	| { type: 'tool_reset' };

export default function App() {
	const [agentName] = useState(getSessionId);
	const [domain, setDomain] = useState('');
	const [activeDomain, setActiveDomain] = useState<string | null>(null);
	const [summary, setSummary] = useState<string | null>(null);
	const [sources, setSources] = useState<Source[]>([]);
	const [tools, setTools] = useState<ToolActivity[]>([]);
	const [researchToolCount, setResearchToolCount] = useState(0);
	const [researchStage, setResearchStage] = useState<ResearchStage>('idle');
	const [researchMessage, setResearchMessage] = useState('');
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [textInput, setTextInput] = useState('');
	const [researchStartedAt, setResearchStartedAt] = useState(0);
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [callActive, setCallActive] = useState(false);
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const [sourcesClosing, setSourcesClosing] = useState(false);
	const [quipIndex, setQuipIndex] = useState(0);
	const [briefing, setBriefing] = useState(false);
	const assistantAudible = useAssistantAudible();
	const acceptsAgentUpdatesRef = useRef(false);
	const domainInputRef = useRef<HTMLInputElement>(null);

	const voice = useVoiceAgent({
		agent: 'DomainVoiceAgent',
		name: agentName,
		silenceThreshold: 0.025,
		silenceDurationMs: 1_200,
		interruptThreshold: 0.06,
		interruptChunks: 3,
	});

	const beginVoice = async () => {
		setCallActive(true);
		try {
			await voice.startCall();
		} catch {
			voice.endCall();
			setCallActive(false);
		}
	};

	useEffect(() => {
		fetch('/api/health')
			.then((response) => response.json() as Promise<{ configured: boolean }>)
			.then((data) => setConfigured(data.configured))
			.catch(() => setConfigured(false));
	}, []);

	useEffect(() => {
		if (!voice.metrics) return;
		console.info('[DomainHR] turn complete', {
			firstAudioMs: voice.metrics.first_audio_ms,
			llmMs: voice.metrics.llm_ms,
			totalMs: voice.metrics.total_ms,
		});
	}, [voice.metrics]);

	useEffect(() => {
		if (!callActive || !voice.error || !/(microphone|transcription|stt|connection (lost|closed)|failed to start)/i.test(voice.error))
			return;
		voice.endCall();
		setCallActive(false);
	}, [callActive, voice.error]);

	useEffect(() => {
		if (!isCustomMessage(voice.lastCustomMessage)) return;
		const message = voice.lastCustomMessage;
		if (!acceptsAgentUpdatesRef.current) return;

		if (message.type === 'tool_call') {
			setTools((current) => upsertTool(current, message.tool));
			return;
		}
		if (message.type === 'tool_reset') {
			setTools((current) => current.map((tool) => (tool.status === 'running' ? { ...tool, status: 'complete' } : tool)));
			return;
		}
		if (message.type === 'research_status') {
			setResearchStage(message.stage);
			setResearchMessage(message.message);
			return;
		}
		if (message.type === 'research_complete') {
			setActiveDomain(message.domain);
			setSummary(message.summary);
			setSources(message.sources);
			setResearchToolCount(tools.length);
			setTools((current) => current.map((tool) => (tool.status === 'running' ? { ...tool, status: 'complete' } : tool)));
			setResearchStage('ready');
			setResearchMessage('Research complete');
			return;
		}
		if (message.type === 'research_error') {
			voice.endCall();
			setCallActive(false);
			setResearchStage('error');
			setErrorMessage(message.message);
			return;
		}
		if (message.type === 'sources') setSources(message.sources);
	}, [voice.lastCustomMessage]);

	const isResearching = researchStage === 'reading' || researchStage === 'searching';
	const hasRunningTool = tools.some((tool) => tool.status === 'running');

	useEffect(() => {
		if (!isResearching) return;
		const interval = setInterval(() => setQuipIndex((index) => (index + 1) % LOADING_QUIPS.length), 2_600);
		return () => clearInterval(interval);
	}, [isResearching]);

	// Once lookups go quiet for a beat, Domi is writing up the brief.
	useEffect(() => {
		if (researchStage !== 'searching' || tools.length === 0 || hasRunningTool) {
			setBriefing(false);
			return;
		}
		const timeout = setTimeout(() => setBriefing(true), 1_400);
		return () => clearTimeout(timeout);
	}, [researchStage, tools.length, hasRunningTool]);

	const closeSources = () => setSourcesClosing(true);

	useEffect(() => {
		if (!sourcesOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') closeSources();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [sourcesOpen]);

	const visibleTranscript = useMemo(
		() => voice.transcript.filter((message) => message.timestamp >= researchStartedAt),
		[researchStartedAt, voice.transcript],
	);
	const currentTool = [...tools].reverse().find((tool) => tool.status === 'running');
	const latestMessage = visibleTranscript.at(-1);
	const isTurnBusy = voice.status === 'thinking' || voice.status === 'speaking';
	const displayStatus = callActive && assistantAudible ? 'speaking' : voice.status;
	const mascotMood: MascotMood = currentTool ? 'thinking' : !callActive ? 'idle' : displayStatus === 'idle' ? 'listening' : displayStatus;
	const speaker = voice.interimTranscript || latestMessage?.role === 'user' ? 'You' : 'Domi';
	const micLevel = callActive && displayStatus === 'listening' && !voice.isMuted ? Math.min(1, voice.audioLevel * 5) : 0;
	const conversationTools = tools.slice(researchToolCount);
	const sourceHosts = useMemo(() => [...new Set(sources.map((source) => rootDomain(getHostname(source.url))))].slice(0, 3), [sources]);
	const bubbleText =
		voice.interimTranscript ||
		latestMessage?.text ||
		(callActive ? `Go ahead, ask me anything about ${activeDomain}.` : `Tap Domi to start talking about ${activeDomain}.`);
	const readingLabel = researchStage === 'reading' ? 'reading the site' : briefing ? 'writing it up' : 'digging around';
	const headline = voiceHeadline(displayStatus, callActive, currentTool);

	const steps: { label: string; detail: string; status: StepStatus }[] = [
		{
			label: 'Read the landing page',
			detail: researchStage === 'reading' ? `Fetching ${activeDomain}` : 'Product copy, pricing, positioning',
			status: researchStage === 'reading' ? 'running' : 'complete',
		},
		{
			label: 'Dig up the missing context',
			detail: currentTool && extractQuery(currentTool.arguments) ? toolLabel(currentTool) : 'Docs, funding, customers, recent news',
			status: researchStage === 'reading' ? 'pending' : briefing ? 'complete' : 'running',
		},
		{
			label: 'Brief Domi',
			detail: 'Boiling it down to plain English',
			status: briefing ? 'running' : 'pending',
		},
	];

	const submitDomain = (event: FormEvent) => {
		event.preventDefault();
		if (!domain.trim() || !voice.connected) return;
		voice.endCall();
		setCallActive(false);
		setActiveDomain(cleanDomainLabel(domain));
		setSummary(null);
		setSources([]);
		setTools([]);
		setResearchToolCount(0);
		setErrorMessage(null);
		setResearchStage('reading');
		setResearchMessage(`Reading ${cleanDomainLabel(domain)}`);
		setResearchStartedAt(Date.now());
		acceptsAgentUpdatesRef.current = true;
		voice.sendJSON({ type: 'research_domain', domain: domain.trim() });
		void beginVoice();
	};

	const submitText = (event: FormEvent) => {
		event.preventDefault();
		const message = textInput.trim();
		if (!message || researchStage !== 'ready' || isTurnBusy) return;
		voice.sendText(message);
		setTextInput('');
	};

	const toggleCall = async () => {
		if (callActive) {
			voice.endCall();
			setCallActive(false);
			return;
		}
		await beginVoice();
	};

	const pickSuggestion = (suggestion: string) => {
		setDomain(suggestion);
		domainInputRef.current?.focus();
	};

	const reset = () => {
		voice.sendJSON({ type: 'cancel_research' });
		acceptsAgentUpdatesRef.current = false;
		voice.endCall();
		setCallActive(false);
		setResearchStage('idle');
		setDomain('');
		setActiveDomain(null);
		setSummary(null);
		setSources([]);
		setTools([]);
		setResearchToolCount(0);
		setErrorMessage(null);
	};

	return (
		<div className="shell">
			<div className="backdrop" aria-hidden="true" />

			<header>
				<button className="wordmark" onClick={reset} aria-label="DomainHR home">
					<PixelLogo className="wordmark-logo" />
					<span>domainhr</span>
				</button>
				{researchStage === 'ready' && (
					<div className="header-actions">
						<button className="button button-ghost quiet-button" onClick={reset}>
							<PixelIcon name="back" />
							New domain
						</button>
						<button className="button button-soft" onClick={() => setSourcesOpen(true)}>
							<span className="favicon-stack" aria-hidden="true">
								{sourceHosts.map((host) => (
									<Favicon key={host} domain={host} />
								))}
							</span>
							Sources
							<span className="count-badge">{sources.length}</span>
						</button>
					</div>
				)}
			</header>

			{(researchStage === 'idle' || researchStage === 'error') && (
				<main className="screen entry-screen" key="entry">
					<Sparkles />
					<div className="hero-mascot reveal" style={{ '--i': 0 } as React.CSSProperties}>
						<p className="speech-tag">psst! give me a domain</p>
						<Mascot mood="idle" />
						<span className="mascot-shadow" />
					</div>
					<div className="entry-copy">
						<p className="eyebrow reveal" style={{ '--i': 1 } as React.CSSProperties}>
							<PixelIcon name="sparkle" />
							Talk to any website
						</p>
						<h1 className="reveal" style={{ '--i': 2 } as React.CSSProperties}>
							What does this company <mark>actually</mark> do?
						</h1>
						<p className="lede reveal" style={{ '--i': 3 } as React.CSSProperties}>
							Drop in a domain. Domi reads the site, digs up the missing context, then talks it through with you. Out loud.
						</p>
					</div>
					<form className="entry-form reveal" style={{ '--i': 4 } as React.CSSProperties} onSubmit={submitDomain}>
						<span className="entry-prefix" aria-hidden="true">
							<PixelIcon name="globe" />
							<span>https://</span>
						</span>
						<input
							ref={domainInputRef}
							aria-label="Company domain"
							autoFocus
							autoComplete="url"
							spellCheck={false}
							placeholder="mistral.ai"
							value={domain}
							onChange={(event) => setDomain(event.target.value)}
						/>
						<button className="button button-primary" type="submit" disabled={!domain.trim() || !voice.connected}>
							{voice.connected ? "Let's go" : 'Connecting'}
							{voice.connected ? <PixelIcon name="arrow" className="nudge" /> : <PixelSpinner />}
						</button>
					</form>
					<div className="suggestions reveal" style={{ '--i': 5 } as React.CSSProperties}>
						<span>Try</span>
						{SUGGESTIONS.map((suggestion) => (
							<button key={suggestion} type="button" className="chip" onClick={() => pickSuggestion(suggestion)}>
								<Favicon domain={suggestion} />
								{suggestion}
							</button>
						))}
					</div>
					{researchStage === 'error' && <ErrorNote>{errorMessage}</ErrorNote>}
					{configured === false && <ErrorNote>Add MISTRAL_API_KEY to .env, then restart the dev server.</ErrorNote>}
				</main>
			)}

			{isResearching && (
				<main className="screen loading-screen" key="loading">
					<div className="stage stage-static">
						<span className="stage-cat">
							<Mascot mood="reading" />
							<span className="mood-bubble mood-bubble-reading" key={readingLabel} aria-hidden="true">
								<PixelSpinner />
								<span className="mood-bubble-text">{readingLabel}</span>
							</span>
						</span>
						<span className="stage-shadow" />
					</div>
					<p className="domain-pill">
						<Favicon domain={activeDomain} />
						{activeDomain}
					</p>
					<h1 key={researchMessage} className="swap-in">
						{researchMessage}
					</h1>
					<p className="quip" key={quipIndex}>
						{LOADING_QUIPS[quipIndex]}
					</p>

					<ol className="steps">
						{steps.map((step, index) => (
							<li key={step.label} className={`step step-${step.status}`} style={{ '--i': index } as React.CSSProperties}>
								<span className="step-marker">
									{step.status === 'running' ? (
										<PixelSpinner />
									) : step.status === 'complete' ? (
										<PixelIcon name="check" />
									) : (
										<span>{index + 1}</span>
									)}
								</span>
								<div className="step-body">
									<strong>{step.label}</strong>
									<span key={step.detail} className="swap-in">
										{step.detail}
									</span>
									{index === 1 && tools.length > 0 && (
										<div className="lookup-meter" aria-label={`${tools.length} web lookups`}>
											{tools.map((tool) => (
												<i key={tool.id} className={tool.status === 'running' ? 'is-running' : ''} />
											))}
											<em>
												{tools.length} lookup{tools.length === 1 ? '' : 's'}
											</em>
										</div>
									)}
								</div>
							</li>
						))}
					</ol>
				</main>
			)}

			{researchStage === 'ready' && summary && (
				<main className={`screen voice-screen mood-${mascotMood}`} key="voice">
					<p className="domain-pill">
						<Favicon domain={activeDomain} />
						{activeDomain}
						<span className={`live-dot${callActive ? ' is-live' : ''}`} />
					</p>

					<button
						className="stage"
						onClick={toggleCall}
						aria-label={callActive ? 'End voice call' : 'Start voice call'}
						style={{ '--level': micLevel } as React.CSSProperties}
					>
						<span className="stage-cat">
							<Mascot mood={mascotMood} />
							<MoodBubble key={mascotMood} mood={mascotMood} level={micLevel} />
						</span>
						<span className="stage-shadow" />
					</button>

					<h1 key={headline} className="swap-in">
						{headline}
					</h1>

					<div className="bubble" aria-live="polite">
						<span key={speaker} className={`speaker speaker-${speaker.toLowerCase()}`}>
							{speaker}
						</span>
						<p key={voice.interimTranscript ? 'interim' : (latestMessage?.timestamp ?? 'empty')} className="swap-in">
							{bubbleText}
						</p>
					</div>

					<div className="tool-slot">
						{currentTool && (
							<div className="tool-live" key={currentTool.id}>
								<PixelSpinner />
								<span>{toolLabel(currentTool)}</span>
							</div>
						)}
					</div>

					<div className="dock">
						<button className={`button call-button${callActive ? ' is-live' : ''}`} onClick={toggleCall}>
							<PixelIcon name={callActive ? 'close' : 'mic'} />
							{callActive ? 'End call' : 'Start talking'}
						</button>
						{callActive && (
							<button
								className={`icon-button mute-button${voice.isMuted ? ' is-muted' : ''}`}
								onClick={voice.toggleMute}
								aria-pressed={voice.isMuted}
								aria-label={voice.isMuted ? 'Unmute microphone' : 'Mute microphone'}
								title={voice.isMuted ? 'Unmute' : 'Mute'}
							>
								<PixelIcon name="mic" />
							</button>
						)}
						<span className="dock-divider" />
						<form className="ask" onSubmit={submitText}>
							<input
								value={textInput}
								onChange={(event) => setTextInput(event.target.value)}
								placeholder="Or type a question…"
								aria-label="Type a question"
							/>
							<button className="icon-button send-button" disabled={!textInput.trim() || isTurnBusy} aria-label="Send">
								<PixelIcon name="arrow" />
							</button>
						</form>
					</div>

					{conversationTools.length > 0 && (
						<div className="recent-lookups">
							<span>Looked up</span>
							{conversationTools.slice(-3).map((tool) => (
								<span key={tool.id} className="lookup-chip">
									{tool.status === 'running' ? <PixelSpinner /> : <PixelIcon name="search" />}
									{lookupLabel(tool)}
								</span>
							))}
						</div>
					)}
					{voice.error && <ErrorNote>{voice.error}</ErrorNote>}
				</main>
			)}

			<footer>
				<a className="repo-link" href={REPO_URL} target="_blank" rel="noreferrer">
					<GitHubMark />
					View source on GitHub
				</a>
			</footer>
			<div className="horizon" aria-hidden="true" />

			{sourcesOpen && (
				<div
					className={`drawer-layer${sourcesClosing ? ' is-closing' : ''}`}
					role="presentation"
					onMouseDown={closeSources}
					onAnimationEnd={(event) => {
						if (sourcesClosing && event.target === event.currentTarget) {
							setSourcesOpen(false);
							setSourcesClosing(false);
						}
					}}
				>
					<aside className="source-drawer" role="dialog" aria-label="Sources" onMouseDown={(event) => event.stopPropagation()}>
						<div className="drawer-header">
							<div>
								<p className="eyebrow">What Domi read</p>
								<h2>
									Sources <span>{sources.length}</span>
								</h2>
							</div>
							<button className="icon-button" onClick={closeSources} aria-label="Close sources">
								<PixelIcon name="close" />
							</button>
						</div>
						<div className="source-list">
							{sources.map((source, index) => (
								<a
									href={source.url}
									target="_blank"
									rel="noreferrer"
									key={source.url}
									style={{ '--i': Math.min(index, 14) } as React.CSSProperties}
								>
									<span className="source-icon">
										<Favicon domain={getHostname(source.url)} />
									</span>
									<div>
										<strong>{source.title}</strong>
										<small>{getHostname(source.url)}</small>
									</div>
									<PixelIcon name="external" className="source-arrow" />
								</a>
							))}
							{sources.length === 0 && <p className="empty-note">No sources yet. Domi is working from the landing page.</p>}
						</div>
					</aside>
				</div>
			)}
		</div>
	);
}

function Favicon({ domain }: { domain: string | null }) {
	const [failed, setFailed] = useState(false);
	if (!domain || failed) return <PixelIcon name="globe" className="favicon favicon-fallback" />;
	return (
		<img
			className="favicon"
			src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
			alt=""
			width={16}
			height={16}
			loading="lazy"
			onError={() => setFailed(true)}
		/>
	);
}

function MoodBubble({ mood, level }: { mood: MascotMood; level: number }) {
	if (mood === 'reading') return null;
	return (
		<span className={`mood-bubble mood-bubble-${mood}`} aria-hidden="true">
			{mood === 'idle' && <span className="mood-bubble-text">tap me to talk</span>}
			{mood === 'listening' && (
				<span className={`mood-bars${level < 0.08 ? ' is-quiet' : ''}`}>
					{BUBBLE_BARS.map((weight, index) => (
						<i
							key={index}
							style={{ height: `${4 + Math.round(level * weight * 4) * 4}px`, animationDelay: `${index * 0.12}s` }}
						/>
					))}
				</span>
			)}
			{mood === 'thinking' && (
				<span className="mood-dots">
					<i />
					<i />
					<i />
				</span>
			)}
			{mood === 'speaking' && <PixelWaves />}
		</span>
	);
}

function GitHubMark() {
	return (
		<svg className="github-mark" viewBox="0 0 16 16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
			/>
		</svg>
	);
}

function ErrorNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="error-message" role="alert">
			<PixelIcon name="alert" />
			<span>{children}</span>
		</p>
	);
}

function Sparkles() {
	return (
		<div className="sparkles" aria-hidden="true">
			{Array.from({ length: 6 }, (_, index) => (
				<span key={index} className={`sparkle sparkle-${index + 1}`}>
					<PixelIcon name="sparkle" />
				</span>
			))}
		</div>
	);
}

function upsertTool(current: ToolActivity[], incoming: ToolActivity): ToolActivity[] {
	const match = current.findIndex((tool) => tool.id === incoming.id);
	if (match === -1) return [...current, incoming];
	const next = [...current];
	next[match] = { ...next[match], ...incoming };
	return next;
}

function toolLabel(tool: ToolActivity): string {
	if (tool.name.includes('web_search')) {
		const query = extractQuery(tool.arguments);
		return query ? `Searching “${query}”` : 'Searching the web';
	}
	return tool.name.replaceAll('_', ' ');
}

function lookupLabel(tool: ToolActivity): string {
	const query = extractQuery(tool.arguments);
	if (query) return `“${query}”`;
	return tool.name.includes('web_search') ? 'Web search' : tool.name.replaceAll('_', ' ');
}

function rootDomain(hostname: string): string {
	return hostname.split('.').slice(-2).join('.');
}

function extractQuery(value?: string): string | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		const query = parsed.query ?? parsed.q;
		return typeof query === 'string' ? query : null;
	} catch {
		return null;
	}
}

function voiceHeadline(status: string, callActive: boolean, tool?: ToolActivity): string {
	if (tool) return 'Digging that up';
	if (!callActive) return 'Ready when you are';
	if (status === 'thinking') return 'Hmm, let me think';
	if (status === 'speaking') return "Here's the scoop";
	return 'All ears';
}

function cleanDomainLabel(value: string): string {
	return value
		.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/$/, '');
}

function getSessionId(): string {
	const key = 'domainhr-session';
	const existing = sessionStorage.getItem(key);
	if (existing) return existing;
	const created = crypto.randomUUID();
	sessionStorage.setItem(key, created);
	return created;
}

function isCustomMessage(value: unknown): value is CustomMessage {
	return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

function getHostname(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}
