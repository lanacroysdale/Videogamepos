// Tiny, dependency-free, XSS-safe Markdown renderer for the internal SOP library.
//
// Strategy: HTML-escape the ENTIRE input first, then apply Markdown transforms
// that emit only a fixed allow-list of tags. Because every "<" in author input
// is already "&lt;" before any transform runs, no input can become a live tag —
// so there is nothing to sanitize afterwards. Links additionally get their URL
// scheme validated (http/https/mailto/relative only) to block "javascript:".
//
// It runs identically on the server (page render) and the client (live editor
// preview) since it has no DOM or Node dependencies. Authors are trusted staff
// (managers), so the supported subset — headings, bold/italic, inline + fenced
// code, links, ordered/unordered lists, task checkboxes, blockquotes, rules — is
// deliberately scoped to what SOPs need rather than full CommonMark.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Allow only safe URL schemes. Operates on already-escaped text, so "&" is
// "&amp;" — harmless inside an href.
function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^\//.test(url) && !/^\/\//.test(url)) return url; // same-site relative
  if (/^#/.test(url)) return url; // in-page anchor
  return null;
}

// Inline spans (bold, italic, code, links) over a single already-escaped line.
// Code spans are split out first (via a capturing split) so that * _ [ ] inside
// them aren't transformed — no in-band sentinel needed, so the source stays
// plain text.
function inline(s: string): string {
  return s
    .split(/(`[^`]+`)/g)
    .map((seg) => {
      if (seg.length >= 2 && seg.startsWith("`") && seg.endsWith("`")) {
        return `<code>${seg.slice(1, -1)}</code>`;
      }
      return seg
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
          const u = safeUrl(url);
          return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
        })
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
    })
    .join("");
}

export function renderMarkdown(src: string | null | undefined): string {
  if (!src) return "";
  const lines = escapeHtml(src.replace(/\r\n/g, "\n")).split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let i = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```
    if (/^```/.test(line.trim())) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // Blank line ends a paragraph.
    if (line.trim() === "") { flushPara(); i++; continue; }

    // Heading: # … ####
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
      i++; continue;
    }

    // Horizontal rule.
    if (/^(---|\*\*\*|___)\s*$/.test(line.trim())) {
      flushPara();
      out.push("<hr />");
      i++; continue;
    }

    // Blockquote (consecutive "> " lines). Lines are already HTML-escaped, so
    // the ">" marker is now "&gt;".
    if (/^&gt;\s?/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // Unordered list, with task-checkbox support ("- [ ]" / "- [x]").
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*[-*+]\s+/, "");
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const checked = task[1].toLowerCase() === "x";
          items.push(`<li class="md-task"><input type="checkbox" disabled${checked ? " checked" : ""} /> ${inline(task[2])}</li>`);
        } else {
          items.push(`<li>${inline(item)}</li>`);
        }
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Plain paragraph text.
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("\n");
}
