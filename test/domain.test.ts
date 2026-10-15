import { describe, expect, it } from 'vitest';
import { jinaReaderUrl, normalizeDomain, speechContextFor } from '../src/domain';

describe('normalizeDomain', () => {
	it('normalizes a bare hostname to HTTPS', () => {
		expect(normalizeDomain('Mistral.ai/')).toEqual({ domain: 'mistral.ai', url: 'https://mistral.ai/' });
	});

	it('drops paths and normalizes HTTP input', () => {
		expect(normalizeDomain('http://www.cloudflare.com/products')).toEqual({
			domain: 'www.cloudflare.com',
			url: 'https://www.cloudflare.com/',
		});
	});

	it.each(['localhost', '127.0.0.1', 'https://10.0.0.1', 'file:///etc/passwd', 'example.test'])('rejects non-public target %s', (input) => {
		expect(() => normalizeDomain(input)).toThrow('public web domains');
	});
});

describe('jinaReaderUrl', () => {
	it('builds a reader URL for the canonical page', () => {
		expect(jinaReaderUrl('https://mistral.ai/')).toBe('https://r.jina.ai/https://mistral.ai/');
	});
});

describe('speechContextFor', () => {
	it('returns no bias before a domain is chosen', () => {
		expect(speechContextFor(null)).toEqual([]);
	});

	it.each([
		['mistral.ai', 'Mistral'],
		['www.cloudflare.com', 'Cloudflare'],
		['api.ibm.com', 'Ibm'],
		['bbc.co.uk', 'Bbc'],
	])('derives the company name for %s', (domain, name) => {
		expect(speechContextFor(domain)).toEqual([domain, name, `Questions about ${name}, the company behind ${domain}.`]);
	});
});
