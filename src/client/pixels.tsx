import type { CSSProperties, ReactElement } from 'react';

export const PALETTE = {
	ink: '#1f1f1f',
	yellow: '#ffaf01',
	tangerine: '#ff8204',
	orange: '#fa500f',
	red: '#e61300',
	crimson: '#c4001d',
	blush: '#ffb598',
	glass: '#b9daff',
	white: '#fffaf0',
} as const;

type Palette = Record<string, string>;

function PixelLayer({ rows, palette, className }: { rows: string[]; palette: Palette; className?: string }) {
	const rects: ReactElement[] = [];
	rows.forEach((row, y) => {
		[...row].forEach((char, x) => {
			const fill = palette[char];
			if (fill) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />);
		});
	});
	return <g className={className}>{rects}</g>;
}

type PixelArtProps = {
	rows: string[];
	palette: Palette;
	className?: string;
	style?: CSSProperties;
};

export function PixelArt({ rows, palette, className, style }: PixelArtProps) {
	const width = Math.max(...rows.map((row) => row.length));
	return (
		<svg
			className={className ? `pixel-art ${className}` : 'pixel-art'}
			style={style}
			viewBox={`0 0 ${width} ${rows.length}`}
			shapeRendering="crispEdges"
			aria-hidden="true"
		>
			<PixelLayer rows={rows} palette={palette} />
		</svg>
	);
}

const LOGO_ROWS = ['.aaaaaaa.', 'bbbbbbbbb', 'cc.c.c.cc', 'ddddddddd', '.eeeeeee.', '.ee......', '.e.......'];

export function PixelLogo({ className }: { className?: string }) {
	return (
		<PixelArt
			className={className}
			rows={LOGO_ROWS}
			palette={{ a: PALETTE.yellow, b: PALETTE.tangerine, c: PALETTE.orange, d: PALETTE.red, e: PALETTE.crimson }}
		/>
	);
}

const CAT_PALETTE: Palette = {
	f: PALETTE.tangerine,
	l: PALETTE.yellow,
	d: PALETTE.orange,
	k: PALETTE.ink,
	w: PALETTE.white,
	p: PALETTE.blush,
	r: PALETTE.red,
	g: PALETTE.glass,
};

const CAT_HEAD = [
	'..ff..........ff....',
	'..flf........flf....',
	'..fllf......fllf....',
	'..fffffdffdfffff....',
	'.ffffffdffdffffff...',
	'kkffffffffffffffkk..',
	'kkffffffffffffffkk..',
	'kkffffffffffffffkk..',
	'kkfppfflkklffppfkk..',
	'.ffffffllllffffff...',
	'..ffllllllllllff....',
	'...ffffffffffff.....',
	'.....ffffffff.......',
	'....................',
	'....................',
	'....................',
];

const CAT_MIC = ['', '', '', '', '', '', '', '', '', '.................k', '.................k', '................k', '.............rrk'];

const CAT_MAGNIFIER = [
	'',
	'',
	'',
	'',
	'',
	'',
	'',
	'',
	'',
	'',
	'..............kkk',
	'.............kgggk',
	'.............kgwgk',
	'.............kgggk',
	'..............kkkk',
	'..................kk',
];

const EYES_OPEN = ['', '', '', '', '', '', '.....wk....wk', '.....kk....kk'];
const EYES_CLOSED = ['', '', '', '', '', '', '', '.....kk....kk'];
const EYES_HAPPY = ['', '', '', '', '', '', '.....k.....k', '....k.k...k.k'];
const EYES_SIDE = ['', '', '', '', '', '', '......k.....k', '......k.....k'];
const MOUTH_CLOSED = ['', '', '', '', '', '', '', '', '', '.......k..k'];
const MOUTH_OPEN = ['', '', '', '', '', '', '', '', '', '.......krrk', '........rr'];

export type MascotMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading';

export function Mascot({ mood = 'idle', className }: { mood?: MascotMood; className?: string }) {
	const blinks = mood === 'idle' || mood === 'listening' || mood === 'reading';
	return (
		<svg
			className={`pixel-art mascot mascot-${mood}${className ? ` ${className}` : ''}`}
			viewBox="0 0 20 16"
			shapeRendering="crispEdges"
			aria-hidden="true"
		>
			<PixelLayer rows={CAT_HEAD} palette={CAT_PALETTE} />
			{mood === 'speaking' && <PixelLayer rows={EYES_HAPPY} palette={CAT_PALETTE} />}
			{mood === 'thinking' && <PixelLayer rows={EYES_SIDE} palette={CAT_PALETTE} />}
			{blinks && (
				<>
					<PixelLayer className="mascot-eyes-open" rows={EYES_OPEN} palette={CAT_PALETTE} />
					<PixelLayer className="mascot-eyes-closed" rows={EYES_CLOSED} palette={CAT_PALETTE} />
				</>
			)}
			{mood === 'speaking' ? (
				<>
					<PixelLayer className="mascot-mouth-open" rows={MOUTH_OPEN} palette={CAT_PALETTE} />
					<PixelLayer className="mascot-mouth-closed" rows={MOUTH_CLOSED} palette={CAT_PALETTE} />
				</>
			) : (
				<PixelLayer rows={MOUTH_CLOSED} palette={CAT_PALETTE} />
			)}
			{mood === 'reading' ? (
				<PixelLayer className="mascot-magnifier" rows={CAT_MAGNIFIER} palette={CAT_PALETTE} />
			) : (
				<PixelLayer rows={CAT_MIC} palette={CAT_PALETTE} />
			)}
		</svg>
	);
}

const ICONS = {
	arrow: ['...#...', '....#..', '#######', '....#..', '...#...'],
	mic: ['..###..', '..###..', '..###..', '#.###.#', '#.###.#', '.#...#.', '..###..', '...#...', '.#####.'],
	close: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
	external: ['..####', '....##', '...#.#', '..#..#', '.#....', '#.....'],
	check: ['......#', '.....#.', '#...#..', '.#.#...', '..#....'],
	wave: ['....#....', '..#.#.#..', '#.#.#.#.#', '#.#.#.#.#', '#.#.#.#.#', '..#.#.#..', '....#....'],
	alert: ['###', '###', '###', '###', '...', '###'],
	sparkle: ['..#..', '..#..', '##.##', '..#..', '..#..'],
	back: ['...#', '..#.', '.#..', '#...', '.#..', '..#.', '...#'],
	search: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....##.', '.....##'],
	globe: ['..###..', '.#.#.#.', '#..#..#', '#######', '#..#..#', '.#.#.#.', '..###..'],
	stack: ['.#####.', '.......', '#######', '#.....#', '#######'],
};

export type IconName = keyof typeof ICONS;

export function PixelIcon({ name, className }: { name: IconName; className?: string }) {
	return <PixelArt className={`pixel-icon${className ? ` ${className}` : ''}`} rows={ICONS[name]} palette={{ '#': 'currentColor' }} />;
}

const WAVE_ARCS = [
	[
		[0, 3],
		[1, 4],
		[0, 5],
	],
	[
		[2, 1],
		[3, 2],
		[4, 3],
		[4, 4],
		[4, 5],
		[3, 6],
		[2, 7],
	],
	[
		[5, 0],
		[6, 1],
		[7, 2],
		[7, 3],
		[7, 4],
		[7, 5],
		[7, 6],
		[6, 7],
		[5, 8],
	],
];

export function PixelWaves({ className }: { className?: string }) {
	return (
		<svg
			className={`pixel-art pixel-waves${className ? ` ${className}` : ''}`}
			viewBox="0 0 8 9"
			shapeRendering="crispEdges"
			aria-hidden="true"
		>
			{WAVE_ARCS.map((arc, index) => (
				<g key={index} className="wave-arc" style={{ animationDelay: `${index * 0.14}s` }}>
					{arc.map(([x, y]) => (
						<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
					))}
				</g>
			))}
		</svg>
	);
}

const SPINNER_CELLS = [
	[0, 0],
	[1, 0],
	[2, 0],
	[2, 1],
	[2, 2],
	[1, 2],
	[0, 2],
	[0, 1],
];

export function PixelSpinner({ className }: { className?: string }) {
	return (
		<svg
			className={`pixel-art pixel-spinner${className ? ` ${className}` : ''}`}
			viewBox="0 0 3 3"
			shapeRendering="crispEdges"
			aria-hidden="true"
		>
			{SPINNER_CELLS.map(([x, y], index) => (
				<rect key={index} x={x} y={y} width={1} height={1} fill="currentColor" style={{ animationDelay: `${index * 0.1 - 0.8}s` }} />
			))}
		</svg>
	);
}
