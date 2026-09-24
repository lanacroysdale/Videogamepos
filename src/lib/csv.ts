// Tiny RFC-4180 delimited-text parser (CSV / TSV / semicolon). Zero deps.
// Handles quoted fields with embedded delimiters, doubled quotes and newlines,
// CRLF line endings and a UTF-8 BOM. Fully-empty lines are dropped.

export function detectDelimiter(text: string): string {
  const head = text.slice(0, 4000).split(/\r?\n/).slice(0, 5).join("\n");
  const count = (ch: string) => (head.match(new RegExp("\\" + ch, "g")) || []).length;
  const tabs = count("\t"), commas = count(","), semis = count(";");
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

export function parseDelimited(text: string, delimiter?: string): string[][] {
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter || detectDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") { inQ = true; continue; }
    if (c === d) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}
