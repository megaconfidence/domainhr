const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain']);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.test'];
const SECOND_LEVEL_SUFFIXES = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);

export type NormalizedDomain = {
	domain: string;
	url: string;
};

export function normalizeDomain(input: string): NormalizedDomain {
	const value = input.trim();
	if (!value || /\s/.test(value)) {
		throw new Error('Enter a valid domain, such as mistral.ai.');
	}

	let parsed: URL;
	try {
		parsed = new URL(value.includes('://') ? value : `https://${value}`);
	} catch {
		throw new Error('Enter a valid domain, such as mistral.ai.');
	}

	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
		throw new Error('Only public web domains are supported.');
	}

	const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
	if (
		!hostname.includes('.') ||
		BLOCKED_HOSTS.has(hostname) ||
		BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
		isIpAddress(hostname)
	) {
		throw new Error('Only public web domains are supported.');
	}

	for (const label of hostname.split('.')) {
		if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)) {
			throw new Error('Enter a valid domain, such as mistral.ai.');
		}
	}

	return {
		domain: hostname,
		url: `https://${hostname}/`,
	};
}

export function jinaReaderUrl(url: string): string {
	return `https://r.jina.ai/${url}`;
}

export function speechContextFor(domain: string | null): string[] {
	if (!domain) return [];
	const labels = domain.split('.');
	const hasSecondLevelSuffix = labels.length > 2 && SECOND_LEVEL_SUFFIXES.has(labels.at(-2)!);
	const label = labels[labels.length - (hasSecondLevelSuffix ? 3 : 2)];
	const name = label.charAt(0).toUpperCase() + label.slice(1);
	return [domain, name, `Questions about ${name}, the company behind ${domain}.`];
}

function isIpAddress(hostname: string): boolean {
	if (hostname.includes(':')) return true;
	const parts = hostname.split('.');
	return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
