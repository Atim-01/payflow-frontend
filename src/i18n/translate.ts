import en from "./en.json";
import fr from "./fr.json";
import { formatNumber, type Locale } from "./format";
export type Translation = (key: string, values?: Record<string, unknown>) => string;
const catalogs: Record<Locale, Record<string, string>> = { en, fr };
export function createTranslation(locale: Locale): Translation {
  return (key, values = {}) => (catalogs[locale][key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in values)) return match;
    const value = values[name];
    return typeof value === "number" || typeof value === "bigint" ? formatNumber(value, locale) : String(value ?? "");
  });
}
/** Only for application-generated labels/errors, never user-authored names or content. */
export function translateMessage(locale: Locale, message: string): string {
  const t = createTranslation(locale);
  if (message in catalogs[locale] || locale === "en") return t(message);
  for (const key of Object.keys(en)) {
    if (!/\{\w+\}/.test(key)) continue;
    const names: string[] = [];
    const pattern = key.split(/(\{\w+\})/).map(part => {
      if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return "(.+?)"; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    const match = new RegExp(`^${pattern}$`).exec(message);
    if (match) return t(key, Object.fromEntries(names.map((name, index) => {
      const value = match[index + 1]!;
      return [name, value in catalogs[locale] ? t(value) : /^\d+$/.test(value) ? BigInt(value) : value];
    })));
  }
  return message;
}
