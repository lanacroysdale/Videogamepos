// Proof-of-warranty email (server only). Sent when a customer registers,
// when staff approve a self-registration, and on "Resend proof".
import { sendEmail, escapeHtml } from "./email";
import { SITE } from "../consts";
import { fmtDate, lengthLabel, readSnapshot, warrantyUrl } from "./warranty";

export type ProofRow = {
  warranty_no: string; token: string; first_name: string; last_name: string; email: string | null;
  item_title: string; item_platform: string | null; item_condition: string | null; serial: string | null;
  sale_date: string; coverage_start: string; coverage_end: string; plan_snapshot: any;
};

export async function sendWarrantyProof(reg: ProofRow, storeName: string): Promise<boolean> {
  if (!reg.email) return false;
  const snap = readSnapshot(reg.plan_snapshot);
  const link = warrantyUrl(reg.token);
  const name = `${reg.first_name} ${reg.last_name}`.trim() || "there";
  const item = [reg.item_title, reg.item_platform, reg.item_condition].filter(Boolean).join(" · ");
  const rows: [string, string][] = [
    ["Warranty number", reg.warranty_no],
    ["Item", item],
    ...(reg.serial ? [["Serial", reg.serial] as [string, string]] : []),
    ["Plan", `${snap.name} (${lengthLabel(snap.months)})`],
    ["Purchased", fmtDate(reg.sale_date, "long")],
    ["Covered through", fmtDate(reg.coverage_end, "long")],
  ];
  const bullets = (title: string, items: string[]) =>
    items.length ? `<h3 style="margin:18px 0 6px;font-size:15px">${escapeHtml(title)}</h3><ul style="margin:0;padding-left:18px">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : "";
  const text = [
    `Hi ${name},`,
    ``,
    `Your ${snap.name} from ${storeName} is registered. Keep this email — it's your proof of warranty.`,
    ``,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ``,
    `View or print your warranty any time: ${link}`,
    ``,
    ...(snap.coverage.length ? [`What's covered:`, ...snap.coverage.map((c) => `  • ${c}`), ``] : []),
    ...(snap.exclusions.length ? [`What's not covered:`, ...snap.exclusions.map((c) => `  • ${c}`), ``] : []),
    ...(snap.terms ? [snap.terms, ``] : []),
    `Questions? Reply to this email or call ${SITE.phoneDisplay}.`,
    `— ${storeName}`,
  ].join("\n");
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">
      <h2 style="margin:0 0 12px">🛡️ Your warranty is registered</h2>
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your <strong>${escapeHtml(snap.name)}</strong> from ${escapeHtml(storeName)} is registered. Keep this email — it's your proof of warranty.</p>
      <table style="border-collapse:collapse;font-size:14px;margin:12px 0">
        ${rows.map(([k, v]) => `<tr><td style="padding:5px 14px 5px 0;color:#666;vertical-align:top"><strong>${escapeHtml(k)}</strong></td><td style="padding:5px 0">${escapeHtml(v)}</td></tr>`).join("")}
      </table>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;font-weight:700">View my warranty</a></p>
      ${bullets("What's covered", snap.coverage)}
      ${bullets("What's not covered", snap.exclusions)}
      ${snap.terms ? `<p style="font-size:13px;color:#555;margin-top:16px">${escapeHtml(snap.terms)}</p>` : ""}
      <p style="margin-top:20px">Questions? Reply to this email or call ${escapeHtml(SITE.phoneDisplay)}.<br>— ${escapeHtml(storeName)}</p>
    </div>`;
  return sendEmail({ to: reg.email, subject: `${reg.warranty_no} · Your ${snap.name} from ${storeName}`, text, html, replyTo: SITE.email }, "warranty");
}
