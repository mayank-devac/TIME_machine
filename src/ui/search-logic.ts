/** Pure logic for the in-room search panel (no DOM, no three). */
import type { Mode } from '../contracts.js';

export const SEARCH_MAX_CHARS = 40;
export const SEARCH_RESULTS = 3;
export const SEARCH_MIN_CHARS = 3;
export const SEARCH_ZOOM = 17;
export const SEARCH_PLACEHOLDER = 'Type or speak a place';

export const KEY_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'] as const;
export const KEY_IDS: readonly string[] = [...KEY_ROWS.join('').split(''), 'BACK'];

/** The search panel lives beside the map table, so only in table mode. */
export const showSearchPanel = (mode: Mode): boolean => mode === 'table';

/** Apply one key press. Letters append (lower case), BACK deletes, extra input is ignored at the cap. */
export function applyKey(text: string, key: string): string {
  if (key === 'BACK') return text.slice(0, -1);
  if (key === 'SPACE') return text.length === 0 || text.endsWith(' ') || text.length >= SEARCH_MAX_CHARS ? text : `${text} `;
  if (!/^[A-Z]$/.test(key) || text.length >= SEARCH_MAX_CHARS) return text;
  return text + key.toLowerCase();
}

/** Clean up what speech recognition returned: trim, collapse spaces, drop a trailing full stop, cap length. */
export function cleanSpoken(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').slice(0, SEARCH_MAX_CHARS);
}

export const canSearch = (text: string): boolean => text.trim().length >= SEARCH_MIN_CHARS;

/** What the text box shows: the placeholder when empty, the tail of long text, and a caret. */
export function displayText(text: string, caret: boolean): { text: string; placeholder: boolean } {
  if (text.length === 0) return { text: SEARCH_PLACEHOLDER, placeholder: true };
  const tail = text.length > 28 ? `…${text.slice(-27)}` : text;
  return { text: caret ? `${tail}|` : tail, placeholder: false };
}

/** Short row label: the part before the first comma plus the next part, trimmed to fit. */
export function resultLabel(label: string): string {
  const parts = label.split(',').map((s) => s.trim()).filter(Boolean);
  const short = parts.slice(0, 2).join(', ') || 'Unnamed place';
  return short.length > 34 ? `${short.slice(0, 33)}…` : short;
}
