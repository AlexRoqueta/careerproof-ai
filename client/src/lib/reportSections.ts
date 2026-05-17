/* Parse the report markdown into structured sections we can render with
 * richer visuals. The mock LLM produces a stable set of `## ` headings
 * (see server/ai.ts), so we use those as anchors but fall back to a
 * generic "Section" rendering for headings we don't recognize. */

export type ReportListItem = {
  /** The text before the first " - "/":" if the bullet uses bold-prefix
   * formatting like "**Title** — body"; otherwise the full bullet. */
  title: string;
  body?: string;
  /** Original markdown for items that don't match the title/body shape. */
  raw: string;
};

export type ReportSection = {
  /** Original heading text — e.g. "Where AI Lands First". */
  heading: string;
  /** Lowercased canonical kind for sections we recognize. */
  kind: ReportSectionKind;
  /** Paragraph text and lone lines, joined with two newlines. */
  paragraphs: string[];
  /** Items detected as unordered or ordered list bullets. */
  items: ReportListItem[];
  /** Whether the list was numbered (action-plan style). */
  ordered: boolean;
  /** Original markdown for fallback rendering. */
  raw: string;
};

export type ParsedReport = {
  /** Title from the leading "# AI Impact Assessment — <Title>" line. */
  title?: string;
  /** Intro paragraphs before the first ## heading. */
  intro: string[];
  sections: ReportSection[];
  /** Full original text for fallback rendering. */
  raw: string;
};

export type ReportSectionKind =
  | "overall"
  | "current_profession"
  | "current_role"
  | "task_decomposition"
  | "where_ai_lands"
  | "leverage"
  | "action_90"
  | "resilience_12mo"
  | "bottom_line"
  | "other";

function detectKind(heading: string): ReportSectionKind {
  const h = heading.toLowerCase();
  if (h.startsWith("overall")) return "overall";
  if (h.includes("current ai impact on this profession") || h.includes("current ai impact")) return "current_profession";
  if (h.includes("current impact of ai on your") || h.includes("your specific role")) return "current_role";
  if (h.includes("task decomposition") || h.includes("task breakdown")) return "task_decomposition";
  if (h.includes("ai lands first") || h.includes("where ai lands") || h.includes("automation exposure")) return "where_ai_lands";
  if (h.includes("leverage") || h.includes("human edge") || h.includes("where you have")) return "leverage";
  if (h.includes("90-day") || h.includes("90 day") || h.includes("action plan")) return "action_90";
  if (h.includes("12-month") || h.includes("12 month") || h.includes("resilience")) return "resilience_12mo";
  if (h.includes("bottom line") || h.includes("summary")) return "bottom_line";
  return "other";
}

/** Strip markdown emphasis markers from a short string. */
export function stripInlineMd(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function parseBullet(raw: string): ReportListItem {
  const cleaned = raw.trim();
  // Match "**Title** — body" / "**Title:** body" / "**Title** - body" where
  // the separator may be a colon outside the bold, an em-dash, or a regular
  // dash.
  const boldSep = cleaned.match(/^\*\*([^*]+?)\*\*\s*[—:\-]\s*(.+)$/);
  if (boldSep) {
    const title = stripInlineMd(boldSep[1]).replace(/:\s*$/, "");
    return { title, body: stripInlineMd(boldSep[2]), raw: cleaned };
  }
  // Match "**Title:** body" where the colon is inside the bold span.
  const boldColon = cleaned.match(/^\*\*([^*]+?:)\*\*\s+(.+)$/);
  if (boldColon) {
    const title = stripInlineMd(boldColon[1]).replace(/:\s*$/, "");
    return { title, body: stripInlineMd(boldColon[2]), raw: cleaned };
  }
  // Match plain "**Title** body" (bold span followed directly by prose).
  const boldOnly = cleaned.match(/^\*\*([^*]+?)\*\*\s+(.+)$/);
  if (boldOnly) {
    const title = stripInlineMd(boldOnly[1]).replace(/:\s*$/, "");
    return { title, body: stripInlineMd(boldOnly[2]), raw: cleaned };
  }
  // "Title: body" pattern without bold — only when the title is short enough
  // that the split feels like a label, not a sentence.
  const colonPrefix = cleaned.match(/^([^:]{2,80}):\s*(.+)$/);
  if (colonPrefix && colonPrefix[1].length < 60 && !colonPrefix[1].includes(".")) {
    return {
      title: stripInlineMd(colonPrefix[1]),
      body: stripInlineMd(colonPrefix[2]),
      raw: cleaned,
    };
  }
  return { title: stripInlineMd(cleaned), raw: cleaned };
}

export function parseReport(markdown: string): ParsedReport {
  const lines = markdown.split(/\r?\n/);
  const sections: ReportSection[] = [];
  let title: string | undefined;
  const intro: string[] = [];
  let current: ReportSection | null = null;
  let buf: string[] = [];
  let inList: "ul" | "ol" | null = null;
  let pendingItems: ReportListItem[] = [];

  const pushParagraph = () => {
    const text = buf.join(" ").trim();
    if (text) {
      if (current) current.paragraphs.push(text);
      else intro.push(text);
    }
    buf = [];
  };

  const closeList = () => {
    if (pendingItems.length && current) {
      current.items.push(...pendingItems);
      current.ordered = inList === "ol";
    }
    pendingItems = [];
    inList = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      pushParagraph();
      closeList();
      continue;
    }
    if (line.startsWith("# ")) {
      pushParagraph();
      closeList();
      const t = line.slice(2).trim();
      const dashSplit = t.split(/[—\-]/);
      if (dashSplit.length > 1) {
        title = dashSplit.slice(1).join("—").trim() || t;
      } else {
        title = t;
      }
      continue;
    }
    if (line.startsWith("## ")) {
      pushParagraph();
      closeList();
      if (current) sections.push(current);
      const heading = stripInlineMd(line.slice(3).trim().replace(/:\s*\*\*.*\*\*\s*$/, ""));
      const cleanHeading = heading.replace(/:\s*$/, "");
      current = {
        heading: cleanHeading,
        kind: detectKind(cleanHeading),
        paragraphs: [],
        items: [],
        ordered: false,
        raw: line + "\n",
      };
      continue;
    }
    if (current) current.raw += line + "\n";
    if (/^---+$/.test(trimmed)) {
      pushParagraph();
      closeList();
      continue;
    }
    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ulMatch) {
      pushParagraph();
      if (inList !== "ul") closeList();
      inList = "ul";
      pendingItems.push(parseBullet(ulMatch[1]));
      continue;
    }
    if (olMatch) {
      pushParagraph();
      if (inList !== "ol") closeList();
      inList = "ol";
      pendingItems.push(parseBullet(olMatch[1]));
      continue;
    }
    closeList();
    buf.push(trimmed);
  }
  pushParagraph();
  closeList();
  if (current) sections.push(current);

  return { title, intro, sections, raw: markdown };
}

export function findSection(
  report: ParsedReport,
  kind: ReportSectionKind,
): ReportSection | undefined {
  return report.sections.find((s) => s.kind === kind);
}

/** Heuristic mapping: assign a 1-100 weight to a task/bullet inside the
 * "Task Decomposition" / "Where AI Lands First" sections so we can render
 * a visual bar without inventing precise claims. The weight is anchored
 * to the overall report risk score and modulated by keyword signals. */
export function inferTaskWeight(
  text: string,
  baseRiskScore: number,
  index: number,
  total: number,
): { weight: number; tier: "Low" | "Moderate" | "High" } {
  const t = text.toLowerCase();
  // Keyword nudges. Routine/structured work skews high; judgment/relational skews low.
  let bias = 0;
  const highKeywords = [
    "drafting",
    "summariz",
    "summary",
    "summaries",
    "data entry",
    "data lookup",
    "reporting",
    "formatting",
    "scheduling",
    "transcription",
    "classification",
    "categoriz",
    "extract",
    "reconciliation",
    "report ",
    "first-draft",
    "first draft",
    "boilerplate",
    "routine",
    "structured",
    "rule-based",
    "automation",
    "search",
    "knowledge lookup",
    "pattern-match",
    "anomaly",
    "forecast",
    "documentation",
  ];
  const lowKeywords = [
    "stakeholder",
    "negotiation",
    "ethical",
    "judgment",
    "ambigu",
    "mentor",
    "leadership",
    "creative direction",
    "strategy",
    "strategic",
    "relationship",
    "trust",
    "client",
    "advisory",
    "in-person",
    "hands-on",
    "domain expertise",
    "safety",
    "physical",
  ];
  const midKeywords = [
    "review",
    "quality control",
    "qc ",
    "oversight",
    "prompt design",
    "hybrid",
    "augment",
  ];
  for (const k of highKeywords) if (t.includes(k)) bias += 14;
  for (const k of lowKeywords) if (t.includes(k)) bias -= 16;
  for (const k of midKeywords) if (t.includes(k)) bias -= 4;

  // Within an ordered list, "first wave" items skew higher.
  const orderNudge = total > 1 ? Math.round(10 - (index * 20) / Math.max(1, total - 1)) : 0;
  const raw = baseRiskScore + bias + orderNudge;
  const weight = Math.max(8, Math.min(96, raw));
  const tier: "Low" | "Moderate" | "High" =
    weight < 40 ? "Low" : weight < 70 ? "Moderate" : "High";
  return { weight, tier };
}
