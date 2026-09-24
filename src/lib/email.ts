// Transactional email through Resend (raw fetch, no SDK — same as the contact
// form). Best-effort by design: returns false instead of throwing so a
// delivery problem never fails the action that triggered it. Without an API
// key the message is logged to the server console.
const API_KEY = process.env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
export const EMAIL_FROM = process.env.CONTACT_FROM || import.meta.env.CONTACT_FROM || "TimeLag Video Games <onboarding@resend.dev>";

export type OutgoingEmail = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: { filename: string; content: string }[]; // base64
};

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function sendEmail(msg: OutgoingEmail, tag = "email"): Promise<boolean> {
  if (!API_KEY) {
    console.warn(`[${tag}] RESEND_API_KEY not set — not sent:\nTo: ${msg.to}\nSubject: ${msg.subject}\n${msg.text}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      }),
    });
    if (res.ok) return true;
    console.error(`[${tag}] Resend error`, res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error(`[${tag}] Resend threw:`, err);
  }
  return false;
}
