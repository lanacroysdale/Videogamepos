// Barcode equivalence for scan lookups. The same retail label reads back in
// several shapes depending on who produced the digits: a phone camera or wedge
// scanner reports a US game's UPC-A as 12 digits ("045496880200"), while eBay's
// catalogue, many suppliers, and hand-entry give the EAN-13 form with a leading
// zero ("0045496880200"); GTIN-14 adds another. GS1 defines these as the SAME
// number, right-aligned and zero-padded to 14 digits — so compare on that key
// instead of the raw string. Non-GTIN codes (internal "TL…" codes, 10-digit
// label codes, SKUs, odd lengths) are left as typed apart from trimming, so
// nothing else changes behaviour.
export function barcodeKey(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (/^\d{12,14}$/.test(s)) return s.padStart(14, "0");
  return s;
}

export function barcodeEq(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = barcodeKey(a);
  return ka !== "" && ka === barcodeKey(b);
}
