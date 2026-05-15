/* Tiny markdown renderer — handles the subset our reports use:
 * headings, bold, italics, lists, hr, paragraphs. Avoids pulling a
 * full markdown library to keep the bundle lean. */

function inline(text: string): string {
  // escape HTML
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // bold **x**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italics *x*
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  // inline code `x`
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const closeLists = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      closeLists();
      continue;
    }
    if (line.startsWith("# ")) {
      flushPara(); closeLists();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      flushPara(); closeLists();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      flushPara(); closeLists();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (/^---+$/.test(line.trim())) {
      flushPara(); closeLists();
      out.push("<hr/>");
    } else if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      if (!inUl) { closeLists(); out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (!inOl) { closeLists(); out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
    } else {
      if (inUl || inOl) closeLists();
      para.push(line);
    }
  }
  flushPara();
  closeLists();
  return out.join("\n");
}

export function Markdown({
  source,
  className,
  locked = false,
}: {
  source: string;
  className?: string;
  locked?: boolean;
}) {
  return (
    <div
      className={`prose-app ${locked ? "prose-app-locked" : ""} ${className ?? ""}`}
      data-locked={locked || undefined}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  );
}
