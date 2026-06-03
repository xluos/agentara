import type { Card, Element } from "@/community/feishu/messaging/types";

/**
 * Walk a card element tree (depth-first) into a flat array so tests can
 * assert on buttons/inputs regardless of how deeply they're nested inside
 * forms/columns/collapsible panels.
 */
export function flattenElements(elements: Element[]): Element[] {
  const out: Element[] = [];
  const walk = (es: Element[]) => {
    for (const e of es) {
      out.push(e);
      const maybeContainer = e as { elements?: Element[]; columns?: Element[] };
      if (Array.isArray(maybeContainer.elements)) walk(maybeContainer.elements);
      if (Array.isArray(maybeContainer.columns)) walk(maybeContainer.columns);
    }
  };
  walk(elements);
  return out;
}

export function findElement(
  elements: Element[],
  // eslint-disable-next-line no-unused-vars
  predicate: (e: Element) => boolean,
): Element | undefined {
  return elements.find(predicate);
}

export function stringifyCard(card: Card): string {
  return JSON.stringify(card);
}
