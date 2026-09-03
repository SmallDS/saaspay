export type PageHeading = { title: string; fromHero: boolean };

export function headingText(value: unknown): string {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/\s+/g, " ").trim()).slice(0, 150).join("");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Share the heading choice between the initial HTML and the interactive page.
export function getPageHeading(data: unknown, fallbackTitle: unknown): PageHeading {
  const content = record(data).content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = record(item);
      const title = headingText(record(block.props).title);
      if (block.type === "Hero" && title) return { title, fromHero: true };
    }
  }
  return { title: headingText(fallbackTitle) || "页面内容", fromHero: false };
}
