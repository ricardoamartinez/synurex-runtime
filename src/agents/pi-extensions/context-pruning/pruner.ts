import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("context-pruning");
const CHARS_PER_TOKEN_ESTIMATE = 4;
// We currently skip pruning tool results that contain images. Still, we count them (approx.) so
// we start trimming prunable tool results earlier when image-heavy context is consuming the window.
const IMAGE_CHAR_ESTIMATE = 8_000;

// ---------------------------------------------------------------------------
// Image pruning: replace old image data with file path references
// ---------------------------------------------------------------------------

/**
 * Try to extract a file path reference from the surrounding text context
 * of a message that contains an image block. Looks for common patterns:
 * - "Read image file [image/png]" preceded by a read tool call to a path
 * - File paths like /home/ubuntu/clawd/generated-image-*.png
 * - [media attached: /path/to/file.jpg ...]
 */
function extractImagePath(content: ReadonlyArray<TextContent | ImageContent>): string | null {
  for (const block of content) {
    if (block.type !== "text") continue;
    const text = block.text;

    // Pattern: /home/.../generated-image-*.png or similar absolute paths
    const absPathMatch = text.match(/(\/[\w./-]+\.(?:png|jpg|jpeg|gif|webp))/i);
    if (absPathMatch) return absPathMatch[1];

    // Pattern: [media attached: /path/to/file.ext (type)]
    const mediaMatch = text.match(/\[media attached:\s*([^\s(]+)/i);
    if (mediaMatch) return mediaMatch[1];

    // Pattern: [file uploaded: /path/to/file.ext ...]
    const uploadMatch = text.match(/\[file uploaded:\s*([^\s(]+)/i);
    if (uploadMatch) return uploadMatch[1];

    // Pattern: Read image file [type] — path is usually in a preceding text block
    // or the image was loaded from a path mentioned earlier
    const readMatch = text.match(/Read image file/i);
    if (readMatch) return null; // Path was in the tool call, not the result
  }
  return null;
}

/**
 * Replace image blocks in a message with text references to their file location.
 * Preserves all non-image content. Returns null if no images were found/replaced.
 */
function replaceImagesWithRefs(
  content: ReadonlyArray<TextContent | ImageContent>,
): Array<TextContent | ImageContent> | null {
  let hasImages = false;
  for (const block of content) {
    if (block.type === "image") {
      hasImages = true;
      break;
    }
  }
  if (!hasImages) return null;

  const imagePath = extractImagePath(content);
  const newContent: Array<TextContent | ImageContent> = [];
  let imagesReplaced = 0;

  for (const block of content) {
    if (block.type === "image") {
      imagesReplaced++;
      // Replace image data with a text reference
      const ref = imagePath
        ? `[Image was here: ${imagePath} — use the read tool to view it again if needed]`
        : `[Image was here — previously viewed image data removed to save context space]`;
      newContent.push(asText(ref));
    } else {
      newContent.push(block);
    }
  }

  if (imagesReplaced > 0) {
    log.debug("Replaced image blocks with path references", { imagesReplaced, imagePath });
  }
  return imagesReplaced > 0 ? newContent : null;
}

function asText(text: string): TextContent {
  return { type: "text", text };
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  // Joined with "\n" separators between blocks.
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (block.type === "image") {
      return true;
    }
  }
  return false;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return content.length;
    }
    let chars = 0;
    for (const b of content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "thinking") {
        chars += b.thinking.length;
      }
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) {
    return messages.length;
  }

  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") {
      continue;
    }
    remaining--;
    if (remaining === 0) {
      return i;
    }
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  // Ignore image tool results for now: these are often directly relevant and hard to partially prune safely.
  if (hasImageBlocks(msg.content)) {
    return null;
  }

  const parts = collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.softTrim.maxChars) {
    return null;
  }

  const headChars = Math.max(0, settings.softTrim.headChars);
  const tailChars = Math.max(0, settings.softTrim.tailChars);
  if (headChars + tailChars >= rawLen) {
    return null;
  }

  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}
...
${tail}`;

  const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
}): AgentMessage[] {
  const { messages, settings, ctx } = params;
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return messages;
  }

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) {
    return messages;
  }

  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return messages;
  }

  // Bootstrap safety: never prune anything before the first user message. This protects initial
  // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
  // message exists in the session transcript.
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  let next: AgentMessage[] | null = null;
  let totalChars = estimateContextChars(messages);

  // ── Phase 0: Image pruning ──────────────────────────────────────────────
  // Always strip old image data from messages outside the protected tail.
  // Images are the #1 context bloat source (~3MB each as base64). Replace them
  // with a text reference to the file path so the agent can re-read if needed.
  // This runs unconditionally (not gated by ratio) because image data accumulates
  // fast and the model doesn't need to "see" old images — just know they existed.
  if (settings.imagePruning.enabled) {
    let imagesPruned = 0;
    for (let i = pruneStartIndex; i < cutoffIndex; i++) {
      const msg = (next ?? messages)[i];
      if (!msg) continue;

      // Handle toolResult messages with images (e.g., read tool returning image data)
      if (msg.role === "toolResult" && hasImageBlocks(msg.content)) {
        const replaced = replaceImagesWithRefs(msg.content);
        if (replaced) {
          const beforeChars = estimateMessageChars(msg);
          const updated = { ...msg, content: replaced } as unknown as AgentMessage;
          const afterChars = estimateMessageChars(updated);
          if (!next) next = messages.slice();
          next[i] = updated;
          totalChars += afterChars - beforeChars;
          imagesPruned++;
        }
      }

      // Handle user messages with images (e.g., uploaded photos injected as native images)
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const content = msg.content as ReadonlyArray<TextContent | ImageContent>;
        if (hasImageBlocks(content)) {
          const replaced = replaceImagesWithRefs(content);
          if (replaced) {
            const beforeChars = estimateMessageChars(msg);
            const updated = { ...msg, content: replaced } as unknown as AgentMessage;
            const afterChars = estimateMessageChars(updated);
            if (!next) next = messages.slice();
            next[i] = updated;
            totalChars += afterChars - beforeChars;
            imagesPruned++;
          }
        }
      }
    }
    if (imagesPruned > 0) {
      log.info("Pruned old images from context", { imagesPruned, cutoffIndex });
    }
  }

  // ── Phase 1: Soft-trim large tool results ───────────────────────────────
  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return next ?? messages;
  }

  const prunableToolIndexes: number[] = [];

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    // Skip tool results that still contain images (inside the protected tail,
    // or image pruning is disabled)
    if (hasImageBlocks(msg.content)) {
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated as unknown as AgentMessage;
  }

  // ── Phase 2: Hard-clear old tool results ────────────────────────────────
  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }

  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const cleared: ToolResultMessage = {
      ...msg,
      content: [asText(settings.hardClear.placeholder)],
    };
    if (!next) {
      next = messages.slice();
    }
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}
