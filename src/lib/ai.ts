// Internal AI assistant core (Claude via the Anthropic API). Server-only — the
// key never reaches the browser. Skills (SEO descriptions, etc.) call callClaude
// with a brand-tuned system prompt + grounded facts. Tunable from POS Settings.
const ANTHROPIC_KEY = import.meta.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;

export const AI_MODELS = [
  { key: "claude-haiku-4-5-20251001", label: "Haiku — fast & cheap" },
  { key: "claude-sonnet-4-6", label: "Sonnet — balanced (recommended)" },
  { key: "claude-opus-4-8", label: "Opus — highest quality" },
];
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Editable brand voice for SEO descriptions (POS Settings → store_settings).
export const DEFAULT_DESCRIPTION_PROMPT = `You write concise, accurate, SEO-friendly product descriptions for TimeLag Video Games, a retro & modern video game shop in Portland, OR.

Voice: friendly, knowledgeable, genuinely enthusiastic — never hypey or salesy.
Format: 2–4 short sentences, ~40–80 words, no headings, no bullet points, no emojis.
Lead with what the item is and its platform. If a condition is given, mention it honestly.
Work in 1–2 natural search keywords (platform, franchise, genre).
NEVER invent specs, features, pricing, or claims that aren't in the provided facts.
You may end with a light nudge to visit or browse in-store if it fits naturally.`;

export interface AiSettings { descriptionPrompt: string; model: string; }
export function aiSettings(raw: any): AiSettings {
  const model = AI_MODELS.some((m) => m.key === raw?.aiModel) ? raw.aiModel : DEFAULT_MODEL;
  return {
    descriptionPrompt: (raw?.aiDescriptionPrompt && String(raw.aiDescriptionPrompt).trim()) || DEFAULT_DESCRIPTION_PROMPT,
    model,
  };
}

export function aiConfigured(): boolean {
  return !!ANTHROPIC_KEY;
}

export async function callClaude(opts: { system: string; user: string; model: string; maxTokens?: number }): Promise<string> {
  if (!ANTHROPIC_KEY) throw new Error("AI is not configured — add ANTHROPIC_API_KEY to your environment.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 600,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `AI request failed (${res.status})`);
  const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  if (!text) throw new Error("AI returned no text");
  return text;
}
