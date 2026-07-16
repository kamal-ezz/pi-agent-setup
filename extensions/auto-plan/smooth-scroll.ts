import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const MOUSE_EVENT = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const WHEEL_LINES = 3;

type ScrollPositionListener = (offset: number, maximum: number) => void;

interface TuiInternals {
  focusedComponent: Component | null;
}

interface ScrollState {
  offset: number;
  maximum: number;
  pageSize: number;
  previousHistoryLines: number;
}

function childComponents(component: Component): readonly Component[] {
  const children = (component as Component & { children?: unknown }).children;
  return Array.isArray(children) ? (children as Component[]) : [];
}

function containsComponent(root: Component, target: Component): boolean {
  if (root === target) return true;
  return childComponents(root).some((child) => containsComponent(child, target));
}

function findStickyBoundary(tui: TUI, editor: Component): Component | undefined {
  const editorRootIndex = tui.children.findIndex((child) =>
    containsComponent(child, editor),
  );
  // Pi places widgetContainerAbove immediately before editorContainer. Keeping
  // both widget containers, the editor, and the footer sticky prevents status
  // changes from moving the history viewport.
  return editorRootIndex > 0 ? tui.children[editorRootIndex - 1] : undefined;
}

function renderChildren(children: readonly Component[], width: number): string[] {
  return children.flatMap((child) => child.render(width));
}

function parseWheel(data: string): -1 | 1 | undefined {
  const match = MOUSE_EVENT.exec(data);
  if (!match) return undefined;
  const button = Number(match[1]);
  if ((button & 64) === 0) return undefined;
  return (button & 1) === 0 ? -1 : 1;
}

/**
 * Replace native terminal scrollback with a stable, viewport-sized conversation
 * pager. This avoids Pi's full-history redraws snapping the terminal to the top
 * or bottom while a response streams or the terminal is resized.
 */
export function installSmoothScrolling(
  tui: TUI,
  editor: Component,
  keybindings: KeybindingsManager,
  onPositionChange: ScrollPositionListener = () => {},
): () => void {
  const stickyBoundary = findStickyBoundary(tui, editor);
  if (!stickyBoundary) return () => {};

  const originalRender = tui.render;
  const stickyIndex = tui.children.indexOf(stickyBoundary);
  const state: ScrollState = {
    offset: 0,
    maximum: 0,
    pageSize: 1,
    previousHistoryLines: 0,
  };
  let disposed = false;

  const notifyPosition = () => onPositionChange(state.offset, state.maximum);
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(state.maximum, state.offset + delta));
    if (next === state.offset) return false;
    state.offset = next;
    notifyPosition();
    tui.requestRender();
    return true;
  };

  const wrappedRender = (width: number): string[] => {
    const history = renderChildren(tui.children.slice(0, stickyIndex), width);
    const sticky = renderChildren(tui.children.slice(stickyIndex), width);
    const height = Math.max(1, tui.terminal.rows || 1);

    if (sticky.length >= height) {
      state.offset = 0;
      state.maximum = 0;
      state.pageSize = 1;
      state.previousHistoryLines = history.length;
      return sticky.slice(-height);
    }

    const historyHeight = Math.max(1, height - sticky.length);
    state.pageSize = Math.max(1, historyHeight - 1);

    // Keep the same history rows on screen when streaming appends below them.
    if (state.offset > 0 && history.length > state.previousHistoryLines) {
      state.offset += history.length - state.previousHistoryLines;
    }

    state.maximum = Math.max(0, history.length - historyHeight);
    state.offset = Math.max(0, Math.min(state.offset, state.maximum));
    state.previousHistoryLines = history.length;

    const start = Math.max(
      0,
      history.length - historyHeight - state.offset,
    );
    const visibleHistory = history.slice(start, start + historyHeight);
    while (visibleHistory.length < historyHeight) visibleHistory.unshift("");
    return [...visibleHistory, ...sticky];
  };

  tui.render = wrappedRender;

  const removeInputListener = tui.addInputListener((data) => {
    const wheel = parseWheel(data);
    const mainEditorFocused =
      (tui as unknown as TuiInternals).focusedComponent === editor;
    const autocompleteVisible = Boolean(
      (editor as Component & { isShowingAutocomplete?: () => boolean })
        .isShowingAutocomplete?.(),
    );
    const historyOwnsInput = mainEditorFocused && !autocompleteVisible;

    if (wheel !== undefined) {
      if (!historyOwnsInput) {
        // Let selectors and custom /ps, /diff, and takeover views use the wheel
        // through their existing arrow-key handlers.
        return { data: wheel < 0 ? ARROW_UP : ARROW_DOWN };
      }
      move(wheel < 0 ? WHEEL_LINES : -WHEEL_LINES);
      return { consume: true };
    }

    // Mouse tracking also reports clicks. Pi has no click targets in the main
    // editor, so consume them rather than leaking escape-sequence text.
    if (MOUSE_EVENT.test(data) && mainEditorFocused) return { consume: true };

    // Replacement/overlay UIs own their keyboard paging. Only capture paging
    // while the normal conversation editor has focus.
    if (!historyOwnsInput) return undefined;
    if (keybindings.matches(data, "tui.editor.pageUp")) {
      if (move(state.pageSize)) return { consume: true };
      return undefined;
    }
    if (keybindings.matches(data, "tui.editor.pageDown")) {
      if (move(-state.pageSize)) return { consume: true };
      return undefined;
    }
    return undefined;
  });

  tui.terminal.write(ENABLE_MOUSE);
  tui.requestRender(true);

  return () => {
    if (disposed) return;
    disposed = true;
    removeInputListener();
    tui.render = originalRender;
    tui.terminal.write(DISABLE_MOUSE);
    onPositionChange(0, 0);
  };
}
