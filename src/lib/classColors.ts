// A user-chosen color per class, stored in Context.color as one of these
// keys (not a raw hex) so existing data keeps working. The redesign uses each
// key as a single solid hue — a small dot in lists, a tinted block on the
// calendar — instead of the old full-row pastel backgrounds.
export const CLASS_COLOR_KEYS = [
  "rose",
  "orange",
  "amber",
  "lime",
  "emerald",
  "teal",
  "cyan",
  "blue",
  "violet",
  "pink",
] as const;

export type ClassColorKey = (typeof CLASS_COLOR_KEYS)[number];

export function isClassColorKey(value: string | null | undefined): value is ClassColorKey {
  return !!value && (CLASS_COLOR_KEYS as readonly string[]).includes(value);
}

/** Mid-saturation hues that hold up as a dot on white and on #191919. */
export const CLASS_COLOR_HEX: Record<ClassColorKey, string> = {
  rose: "#d9366b",
  orange: "#e0702a",
  amber: "#c48a00",
  lime: "#5e9e1a",
  emerald: "#1e8f5a",
  teal: "#12877f",
  cyan: "#0e8bb0",
  blue: "#2f6feb",
  violet: "#8a4fd8",
  pink: "#c9407a",
};

/** Neutral used for a class with no color picked. */
export const NO_CLASS_COLOR_HEX = "#8e8e8a";

export function classColorHex(key: string | null | undefined): string {
  return isClassColorKey(key) ? CLASS_COLOR_HEX[key] : NO_CLASS_COLOR_HEX;
}

/** A see-through tint of any 6-digit hex, readable in both themes (~15%). */
export function tint(hex: string, alpha = 0.15): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}
