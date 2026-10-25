export const TABS = [
  ["capture", "Baseline capture"],
  ["environments", "Environments"],
  ["evidence", "Evidence"],
  ["ask", "Ask why"],
  ["timeline", "Timeline"],
  ["compare", "Compare & review"],
  ["learning", "What we learned"],
  ["casefile", "Case file"],
  ["scope", "Search width"],
] as const;

export type SectionKey = (typeof TABS)[number][0];

export const activeSection = (tab: string): SectionKey => (TABS.find(([k]) => k === tab)?.[0] ?? "capture");
export const sectionLabel = (tab: string) => TABS.find(([k]) => k === activeSection(tab))![1];
