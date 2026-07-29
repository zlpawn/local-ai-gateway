// Extracts conversation summary text from Codex compaction/summary input items.
//
// When Codex triggers context compaction it replaces prior conversation history
// with a compact summary item (type "compaction", carrying a "text" or "summary"
// field). Third-party models don't understand these item types, so the summary
// must be surfaced as a regular message to avoid losing context.

const COMPACTION_TYPES = new Set(["compaction", "summary"]);

export function extractCompactionSummary(item) {
  if (!item || typeof item !== "object") return null;
  if (!COMPACTION_TYPES.has(item.type)) return null;

  const text =
    typeof item.text === "string" ? item.text :
    typeof item.summary === "string" ? item.summary :
    "";
  if (!text.trim()) return null;
  return text;
}
