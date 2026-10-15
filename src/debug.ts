export function debugLog(component: string, event: string, data: Record<string, unknown> = {}): void {
	console.info(`[DomainHR:${component}] ${event}`, {
		timestamp: new Date().toISOString(),
		...data,
	});
}

export function textPreview(value: string, length = 100): string {
	const normalized = value.replace(/\s+/g, ' ').trim();
	return normalized.length > length ? `${normalized.slice(0, length)}…` : normalized;
}
