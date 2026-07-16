import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { installSmoothScrolling } from "./smooth-scroll.ts";

class Lines implements Component {
  lines: string[];
  children?: Component[];

  constructor(lines: string[] = [], children?: Component[]) {
    this.lines = lines;
    this.children = children;
  }

  render(): string[] {
    if (this.children) return this.children.flatMap((child) => child.render(80));
    return this.lines;
  }

  invalidate(): void {}
}

function harness() {
  const history = new Lines(Array.from({ length: 8 }, (_, i) => `h${i}`));
  const widgetAbove = new Lines();
  const editor = new Lines(["editor"]);
  const editorContainer = new Lines([], [editor]);
  const footer = new Lines(["footer"]);
  let inputListener: (data: string) =>
    | { consume?: boolean; data?: string }
    | undefined = () => undefined;
  const writes: string[] = [];
  let renders = 0;

  const originalRender = function (this: { children: Component[] }, width: number) {
    return this.children.flatMap((child) => child.render(width));
  };
  const tui = {
    children: [history, widgetAbove, editorContainer, footer],
    terminal: {
      rows: 6,
      columns: 80,
      write: (data: string) => writes.push(data),
    },
    focusedComponent: editor,
    render: originalRender,
    requestRender: () => {
      renders++;
    },
    addInputListener: (listener: typeof inputListener) => {
      inputListener = listener;
      return () => {
        inputListener = () => undefined;
      };
    },
  } as unknown as TUI;
  const keybindings = {
    matches: (data: string, action: string) =>
      (data === "P" && action === "tui.editor.pageUp") ||
      (data === "N" && action === "tui.editor.pageDown"),
  } as KeybindingsManager;

  return {
    tui,
    history,
    editor,
    originalRender,
    keybindings,
    writes,
    get renders() {
      return renders;
    },
    send(data: string) {
      return inputListener(data);
    },
  };
}

test("conversation paging keeps sticky controls fixed and streaming history stable", () => {
  const view = harness();
  const positions: Array<[number, number]> = [];
  const cleanup = installSmoothScrolling(
    view.tui,
    view.editor,
    view.keybindings,
    (offset, maximum) => positions.push([offset, maximum]),
  );

  assert.deepEqual(view.tui.render(80), ["h4", "h5", "h6", "h7", "editor", "footer"]);
  assert.deepEqual(view.send("P"), { consume: true });
  assert.deepEqual(view.tui.render(80), ["h1", "h2", "h3", "h4", "editor", "footer"]);

  view.history.lines.push("h8");
  assert.deepEqual(
    view.tui.render(80),
    ["h1", "h2", "h3", "h4", "editor", "footer"],
    "new output should not move the history being read",
  );
  assert.deepEqual(positions.at(-1), [3, 4]);
  assert.ok(view.renders >= 2);

  cleanup();
  assert.equal(view.tui.render, view.originalRender);
  assert.equal(view.writes[0], "\x1b[?1000h\x1b[?1006h");
  assert.equal(view.writes.at(-1), "\x1b[?1000l\x1b[?1006l");
});

test("mouse wheel scrolls history and becomes arrows in custom views", () => {
  const view = harness();
  installSmoothScrolling(view.tui, view.editor, view.keybindings);
  view.tui.render(80);

  assert.deepEqual(view.send("\x1b[<64;10;4M"), { consume: true });
  assert.deepEqual(view.tui.render(80), ["h1", "h2", "h3", "h4", "editor", "footer"]);
  assert.deepEqual(view.send("\x1b[<65;10;4M"), { consume: true });
  assert.deepEqual(view.tui.render(80), ["h4", "h5", "h6", "h7", "editor", "footer"]);

  (view.tui as unknown as { focusedComponent: Component | null }).focusedComponent =
    new Lines(["custom"]);
  assert.deepEqual(view.send("\x1b[<64;10;4M"), { data: "\x1b[A" });
  assert.deepEqual(view.send("\x1b[<65;10;4M"), { data: "\x1b[B" });
  assert.equal(view.send("P"), undefined, "custom views keep ownership of page keys");
});
