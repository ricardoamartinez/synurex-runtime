import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { markdownTheme, theme } from "../theme/theme.js";

export class UserMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string) {
    super();
    const prefix = `${theme.accent("wish")} ${chalk.hex("#DB2777")("›")}`;
    this.body = new Markdown(text, 1, 1, markdownTheme, {
      bgColor: (line) => theme.userBg(line),
      color: (line) => theme.userText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(new Text(prefix, 1, 0));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }
}
