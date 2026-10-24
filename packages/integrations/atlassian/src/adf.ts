export type AdfText = {
  type: "text";
  text: string;
};

export type AdfParagraph = {
  type: "paragraph";
  content: AdfText[];
};

export type AdfBulletList = {
  type: "bulletList";
  content: Array<{ type: "listItem"; content: AdfParagraph[] }>;
};

export type AdfBlock = AdfParagraph | AdfBulletList;

export type AdfDoc = {
  type: "doc";
  version: 1;
  content: AdfBlock[];
};

export function adfDoc(...blocks: AdfBlock[]): AdfDoc {
  return { type: "doc", version: 1, content: blocks };
}

export function adfParagraph(text: string): AdfParagraph {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

export function adfBulletList(items: string[]): AdfBulletList {
  return {
    type: "bulletList",
    content: items.map((text) => ({
      type: "listItem",
      content: [adfParagraph(text)],
    })),
  };
}

export function adfToPlainText(doc: unknown): string {
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "text" && typeof node.text === "string") {
      texts.push(node.text);
    }
    if (node.content !== undefined) visit(node.content);
  };
  visit(doc);
  return texts.join("\n");
}
