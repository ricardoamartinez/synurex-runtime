import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { markdownTheme, theme } from "../theme/theme.js";

function buildDivider(label: string, width = 60): string {
  const dashes = "─".repeat(Math.max(0, Math.floor((width - label.length - 2) / 2)));
  const right = "─".repeat(Math.max(0, width - label.length - 2 - dashes.length));
  return `${theme.border(dashes)} ${theme.accent(label)} ${theme.border(right)}`;
}

export class AssistantMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string) {
    super();
    const divider = buildDivider("synurex");
    this.body = new Markdown(text, 1, 0, markdownTheme, {
      color: (line) => theme.fg(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(new Text(divider, 1, 0));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }
}
