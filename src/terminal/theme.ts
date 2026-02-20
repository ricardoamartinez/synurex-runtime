import chalk, { Chalk } from "chalk";
import { SYNUREX_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(SYNUREX_PALETTE.accent),
  accentBright: hex(SYNUREX_PALETTE.accentBright),
  accentDim: hex(SYNUREX_PALETTE.accentDim),
  info: hex(SYNUREX_PALETTE.info),
  success: hex(SYNUREX_PALETTE.success),
  warn: hex(SYNUREX_PALETTE.warn),
  error: hex(SYNUREX_PALETTE.error),
  muted: hex(SYNUREX_PALETTE.muted),
  heading: baseChalk.bold.hex(SYNUREX_PALETTE.accent),
  command: hex(SYNUREX_PALETTE.accentBright),
  option: hex(SYNUREX_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
