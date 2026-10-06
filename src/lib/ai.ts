// Internal AI assistant core — provider-switchable (Gemini and/or Claude). Uses
// whichever key is present; if both, an explicit provider preference (POS
// Settings) decides, else it prefers Gemini (free tier). Server-only — keys never
// reach the browser. No SDK; direct API calls.
const ANTHROPIC_KEY = import.meta.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY =
  import.meta.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ??
  import.meta.env.GOOGLE_API_KEY ?? process.env.GOOGLE_API_KEY;

export const AI_PROVIDERS = [
  { key: "auto", label: "Auto — use whichever key is set" },
  { key: "gemini", label: "Gemini (Google)" },
  { key: "anthropic", label: "Claude (Anthropic)" },
];
export const AI_QUALITIES = [
  { key: "fast", label: "Fast & cheap" },
  { key: "balanced", label: "Balanced (recommended)" },
  { key: "best", label: "Highest quality" },
];

// Concrete model per provider × quality (one place to update if names change).
// Gemini uses Google's "-latest" aliases — pinned versions get retired (2.0 and
// 2.5 already refuse new keys), the aliases follow the current model.
const MODELS: Record<string, Record<string, string>> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", balanced: "claude-sonnet-4-6", best: "claude-opus-4-8" },
  gemini: { fast: "gemini-flash-lite-latest", balanced: "gemini-flash-latest", best: "gemini-pro-latest" },
};
// A busy (503), over-quota (429 — Pro has no free tier) or missing (404) Gemini
// model steps down this ladder instead of failing the request.
const GEMINI_LADDER = ["gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest"];

// Editable brand voice for SEO descriptions (POS Settings → store_settings).
export const DEFAULT_DESCRIPTION_PROMPT = `You write concise, accurate, SEO-friendly product descriptions for TimeLag Video Games, a retro & modern video game shop in Portland, OR.

Voice: friendly, knowledgeable, genuinely enthusiastic — never hypey or salesy.
Format: 2–4 short sentences, ~40–80 words, no headings, no bullet points, no emojis.
Lead with what the item is and its platform. If a condition is given, mention it honestly.
Work in 1–2 natural search keywords (platform, franchise, genre).
NEVER invent specs, features, pricing, or claims that aren't in the provided facts.
You may end with a light nudge to visit or browse in-store if it fits naturally.`;

export interface AiSettings { descriptionPrompt: string; provider: string; quality: string; }
export function aiSettings(raw: any): AiSettings {
  return {
    descriptionPrompt: (raw?.aiDescriptionPrompt && String(raw.aiDescriptionPrompt).trim()) || DEFAULT_DESCRIPTION_PROMPT,
    provider: AI_PROVIDERS.some((p) => p.key === raw?.aiProvider) ? raw.aiProvider : "auto",
    quality: AI_QUALITIES.some((q) => q.key === raw?.aiQuality) ? raw.aiQuality : "balanced",
  };
}

// Resolve the provider actually used, honouring the preference + available keys.
function resolveProvider(pref: string): "gemini" | "anthropic" | null {
  const hasG = !!GEMINI_KEY, hasA = !!ANTHROPIC_KEY;
  if (pref === "gemini" && hasG) return "gemini";
  if (pref === "anthropic" && hasA) return "anthropic";
  if (hasG) return "gemini"; // auto / unavailable pref → prefer free
  if (hasA) return "anthropic";
  return null;
}

export function aiConfigured(): boolean { return !!GEMINI_KEY || !!ANTHROPIC_KEY; }
export function aiStatus(pref = "auto"): { configured: boolean; provider: "gemini" | "anthropic" | null } {
  const p = resolveProvider(pref);
  return { configured: !!p, provider: p };
}

// temperature: lower = steadier answers (0.2 for extracting facts; default 0.7 for writing).
export async function callAI(opts: { system: string; user: string; settings: AiSettings; maxTokens?: number; temperature?: number }): Promise<string> {
  const provider = resolveProvider(opts.settings.provider);
  if (!provider) throw new Error("AI isn't set up yet — add GEMINI_API_KEY or ANTHROPIC_API_KEY to your environment.");
  const model = MODELS[provider][opts.settings.quality] || MODELS[provider].balanced;
  return provider === "anthropic"
    ? callClaude({ system: opts.system, user: opts.user, model, maxTokens: opts.maxTokens, temperature: opts.temperature })
    : callGemini({ system: opts.system, user: opts.user, model, maxTokens: opts.maxTokens, temperature: opts.temperature });
}

async function callClaude(o: { system: string; user: string; model: string; maxTokens?: number; temperature?: number }): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: o.model, max_tokens: o.maxTokens ?? 600, system: o.system, messages: [{ role: "user", content: o.user }], ...(o.temperature != null ? { temperature: o.temperature } : {}) }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `Claude request failed (${res.status})`);
  const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  if (!text) throw new Error("Claude returned no text");
  return text;
}

async function callGemini(o: { system: string; user: string; model: string; maxTokens?: number; temperature?: number }): Promise<string> {
  const i = GEMINI_LADDER.indexOf(o.model);
  const ladder = i < 0 ? [o.model] : GEMINI_LADDER.slice(i);
  let lastErr = "";
  for (const model of ladder) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY!, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: o.system }] },
        contents: [{ role: "user", parts: [{ text: o.user }] }],
        // Gemini 3 "thinks" first and those tokens count toward maxOutputTokens
        // (~575 at "low") — keep it low + add headroom so the answer isn't cut off.
        generationConfig: { maxOutputTokens: (o.maxTokens ?? 600) + 2048, temperature: o.temperature ?? 0.7, thinkingConfig: { thinkingLevel: "low" } },
      }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastErr = j?.error?.message || `Gemini request failed (${res.status})`;
      if ([404, 429, 503].includes(res.status)) continue;
      throw new Error(lastErr);
    }
    const c = j.candidates?.[0];
    const text = (c?.content?.parts || []).map((p: any) => p.text).filter(Boolean).join("").trim();
    if (!text) throw new Error("Gemini returned no text");
    if (c.finishReason === "MAX_TOKENS") throw new Error("Gemini's answer got cut off — try again");
    return text;
  }
  throw new Error(lastErr);
}
