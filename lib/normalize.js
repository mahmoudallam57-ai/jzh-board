// Text normalization shared by the student API. Names are compared by their
// normalized form so spelling variants (أحمد / احمد, فاطمة / فاطمه) are one student.

const DIACRITICS = /[ً-ٰٟـ]/g; // harakat, superscript alef, tatweel

export function normalizeName(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizePin(s) {
  return String(s ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, "");
}

export function isValidPin(s) {
  if (s === undefined || s === null) return false;
  return /^\d{4}$/.test(normalizePin(s));
}
