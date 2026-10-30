import { describe, expect, it } from 'vitest';
import { blockedByFamilyDns, blockedByName, parseClassification } from '../src/content-filter';

describe('blockedByName', () => {
	it.each([
		['pornhub.com', 'adult'],
		['www.xvideos.com', 'adult'],
		['something.xxx', 'adult'],
		['mycams.sex', 'adult'],
		['onlyfans.com', 'adult'],
		['bet365.com', 'gambling'],
		['sports.betway.co.uk', 'gambling'],
		['stake.com', 'gambling'],
		['www.stake.us', 'gambling'],
		['bestcasinosites.net', 'gambling'],
		['lucky.casino', 'gambling'],
		['play.bet', 'gambling'],
		['sportsbook.draftkings.com', 'gambling'],
	])('blocks %s as %s', (domain, category) => {
		expect(blockedByName(domain)).toBe(category);
	});

	it.each(['mistral.ai', 'example.com', 'huggingface.co', 'essex.ac.uk', 'alphabet.com', 'betterhelp.com', 'mistake.com', 'sussex.ac.uk', 'espn.com'])(
		'allows %s',
		(domain) => {
			expect(blockedByName(domain)).toBeNull();
		},
	);
});

describe('blockedByFamilyDns', () => {
	const dnsReply = (ips: string[]) => (async () => Response.json({ Answer: ips.map((data) => ({ type: 1, data })) })) as unknown as typeof fetch;

	it('flags domains the family resolver sinkholes', async () => {
		expect(await blockedByFamilyDns('blocked.example', dnsReply(['0.0.0.0']))).toBe('adult');
	});

	it('allows domains with normal answers', async () => {
		expect(await blockedByFamilyDns('mistral.ai', dnsReply(['172.66.2.203']))).toBeNull();
	});

	it('lets research continue when the lookup fails', async () => {
		const failing = (async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		expect(await blockedByFamilyDns('mistral.ai', failing)).toBeNull();
	});
});

describe('parseClassification', () => {
	it.each([
		['{"category": "gambling"}', 'gambling'],
		['{"category":"adult"}', 'adult'],
		['{"category": "ok"}', null],
		['not json', null],
		[undefined, null],
	])('reads %s', (content, category) => {
		expect(parseClassification(content)).toBe(category);
	});
});
