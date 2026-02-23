import { resolveCommitHash } from "../infra/git-commit.js";
import { visibleWidth } from "../terminal/ansi.js";
import { isRich, theme } from "../terminal/theme.js";
import { pickTagline, type TaglineOptions } from "./tagline.js";

type BannerOptions = TaglineOptions & {
  argv?: string[];
  commit?: string | null;
  columns?: number;
  richTty?: boolean;
};

let bannerEmitted = false;

const hasJsonFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V" || arg === "-v");

// ─── Aurora gradient (matches synurex.com provisioning animation) ────
// Colors: purple → pink → blue → orange → purple (looping)
const AURORA_STOPS: [number, number, number][] = [
  [147, 51, 234],  // #9333ea purple
  [219, 39, 119],  // #db2777 pink
  [59, 130, 246],  // #3b82f6 blue
  [255, 140, 60],  // #ff8c3c orange
  [147, 51, 234],  // #9333ea purple (wrap)
];

function lerpColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function auroraColor(position: number): [number, number, number] {
  // position is 0..1 across the gradient
  const scaled = position * (AURORA_STOPS.length - 1);
  const idx = Math.floor(scaled);
  const t = scaled - idx;
  const a = AURORA_STOPS[Math.min(idx, AURORA_STOPS.length - 1)];
  const b = AURORA_STOPS[Math.min(idx + 1, AURORA_STOPS.length - 1)];
  return lerpColor(a, b, t);
}

function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// ─── Synurex ASCII art (exact match from synurex.com) ────────────────
const SYNUREX_ASCII = [
  "╔═╗╦ ╦╔╗╔╦ ╦╦═╗╔═╗═╗ ╦",
  "╚═╗╚╦╝║║║║ ║╠╦╝║╣ ╔╩╦╝",
  "╚═╝ ╩ ╝╚╝╚═╝╩╚═╚═╝╩ ╚═",
];

/** Apply aurora gradient to a single line of text at a given phase offset */
function auroraLine(text: string, phaseOffset: number): string {
  const chars = Array.from(text);
  const len = chars.length;
  if (len === 0) return "";
  return chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const pos = ((i / Math.max(len - 1, 1)) + phaseOffset) % 1.0;
      const [r, g, b] = auroraColor(pos < 0 ? pos + 1 : pos);
      return `${rgb(r, g, b)}${BOLD}${ch}`;
    })
    .join("") + RESET;
}

/** Render the static ASCII banner with aurora gradient applied */
export function formatCliBannerArt(options: BannerOptions = {}): string {
  const rich = options.richTty ?? isRich();

  if (!rich) {
    return SYNUREX_ASCII.join("\n");
  }

  // Apply gradient at phase 0 (static snapshot)
  return SYNUREX_ASCII.map((line, lineIdx) => {
    const offset = lineIdx * 0.15; // slight shift per row for diagonal effect
    return auroraLine(line, offset);
  }).join("\n");
}

/**
 * Animate the banner with a flowing aurora gradient.
 * Writes directly to stdout with cursor manipulation.
 * Returns a promise that resolves when animation completes.
 */
export async function animateCliBanner(options: BannerOptions = {}): Promise<void> {
  const rich = options.richTty ?? isRich();
  if (!rich) return;

  const columns = options.columns ?? process.stdout.columns ?? 80;
  const artWidth = Math.max(...SYNUREX_ASCII.map((l) => l.length));
  const padLeft = Math.max(0, Math.floor((columns - artWidth) / 2));
  const padding = " ".repeat(padLeft);

  const totalLines = SYNUREX_ASCII.length;
  const FRAMES = 30;
  const FRAME_MS = 50; // 50ms per frame = ~1.5s total animation

  // Hide cursor during animation
  process.stdout.write("\x1b[?25l");

  // Write initial blank lines to reserve space
  for (let i = 0; i < totalLines; i++) {
    process.stdout.write("\n");
  }

  for (let frame = 0; frame < FRAMES; frame++) {
    const phase = frame / FRAMES;

    // Move cursor up to start of art
    process.stdout.write(`\x1b[${totalLines}A`);

    for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
      const offset = phase + lineIdx * 0.15;
      const colored = auroraLine(SYNUREX_ASCII[lineIdx], offset);
      process.stdout.write(`\r${padding}${colored}\x1b[K\n`);
    }

    await new Promise((r) => setTimeout(r, FRAME_MS));
  }

  // Final frame — leave the last gradient state visible
  process.stdout.write(`\x1b[${totalLines}A`);
  for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
    const offset = lineIdx * 0.15;
    const colored = auroraLine(SYNUREX_ASCII[lineIdx], offset);
    process.stdout.write(`\r${padding}${colored}\x1b[K\n`);
  }

  // Show cursor again
  process.stdout.write("\x1b[?25h");
}

// ─── Info line ───────────────────────────────────────────────────────

export function formatCliBannerLine(version: string, options: BannerOptions = {}): string {
  const commit = options.commit ?? resolveCommitHash({ env: options.env });
  const commitLabel = commit ?? "unknown";
  const tagline = pickTagline(options);
  const rich = options.richTty ?? isRich();
  const title = "⚡ Synurex";
  const prefix = "⚡ ";
  const columns = options.columns ?? process.stdout.columns ?? 120;
  const plainFullLine = `${title} ${version} (${commitLabel}) — ${tagline}`;
  const fitsOnOneLine = visibleWidth(plainFullLine) <= columns;
  if (rich) {
    if (fitsOnOneLine) {
      return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
        `(${commitLabel})`,
      )} ${theme.muted("—")} ${theme.accentDim(tagline)}`;
    }
    const line1 = `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
      `(${commitLabel})`,
    )}`;
    const line2 = `${" ".repeat(prefix.length)}${theme.accentDim(tagline)}`;
    return `${line1}\n${line2}`;
  }
  if (fitsOnOneLine) {
    return plainFullLine;
  }
  const line1 = `${title} ${version} (${commitLabel})`;
  const line2 = `${" ".repeat(prefix.length)}${tagline}`;
  return `${line1}\n${line2}`;
}

// ─── Main emit ───────────────────────────────────────────────────────

export async function emitCliBanner(version: string, options: BannerOptions = {}) {
  if (bannerEmitted) {
    return;
  }
  const argv = options.argv ?? process.argv;
  if (!process.stdout.isTTY) {
    return;
  }
  if (hasJsonFlag(argv)) {
    return;
  }
  if (hasVersionFlag(argv)) {
    return;
  }

  const rich = options.richTty ?? isRich();

  process.stdout.write("\n");

  // Animated aurora gradient on the ASCII art
  if (rich) {
    await animateCliBanner(options);
  } else {
    process.stdout.write(formatCliBannerArt(options) + "\n");
  }

  const line = formatCliBannerLine(version, options);
  process.stdout.write(`\n${line}\n\n`);
  bannerEmitted = true;
}

export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}
