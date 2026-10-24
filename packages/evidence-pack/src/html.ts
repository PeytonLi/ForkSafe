const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string | number): string => String(s).replace(/[&<>"']/g, (c) => ESC[c] as string);
