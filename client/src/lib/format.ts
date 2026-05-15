export function formatBytes(bytes: number): string {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function riskColor(risk: string): string {
  switch (risk) {
    case "High":
      return "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30";
    case "Medium":
      return "text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/30";
    case "Low":
      return "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
    default:
      return "text-muted-foreground bg-muted border-border";
  }
}

export function toTitleCase(value: string | null | undefined): string {
  if (!value) return "";
  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per", "the", "to", "vs", "via", "with"]);
  const acronyms = new Set(["ai", "api", "cfo", "cio", "coo", "cto", "hr", "it", "qa", "seo", "ui", "ux"]);
  return value
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word, index, words) => {
      const parts = word.split(/([-/])/);
      return parts
        .map((part) => {
          if (part === "-" || part === "/") return part;
          const cleaned = part.toLowerCase();
          if (acronyms.has(cleaned)) return cleaned.toUpperCase();
          if (index > 0 && index < words.length - 1 && smallWords.has(cleaned)) return cleaned;
          return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        })
        .join("");
    })
    .join(" ");
}
