import { describe, expect, it } from 'vitest';
import {
  KEY_IDS,
  SEARCH_MAX_CHARS,
  SEARCH_PLACEHOLDER,
  applyKey,
  canSearch,
  cleanSpoken,
  displayText,
  resultLabel,
  showSearchPanel,
} from './search-logic.js';

describe('search keys', () => {
  it('types lower case letters, spaces and deletes', () => {
    let t = '';
    for (const k of ['P', 'A', 'R', 'SPACE', 'SPACE', 'I', 'BACK', 'BACK']) t = applyKey(t, k);
    expect(t).toBe('par');
  });
  it('ignores a leading space, unknown keys and input past the cap', () => {
    expect(applyKey('', 'SPACE')).toBe('');
    expect(applyKey('a', '1')).toBe('a');
    const full = 'a'.repeat(SEARCH_MAX_CHARS);
    expect(applyKey(full, 'B')).toBe(full);
    expect(applyKey('', 'BACK')).toBe('');
  });
  it('has a key id for every letter plus BACK', () => {
    expect(KEY_IDS).toHaveLength(27);
  });
});

describe('search text', () => {
  it('cleans spoken text', () => {
    expect(cleanSpoken('  Eiffel   Tower. ')).toBe('Eiffel Tower');
    expect(cleanSpoken('x'.repeat(100))).toHaveLength(SEARCH_MAX_CHARS);
  });
  it('needs three characters to search', () => {
    expect(canSearch('  ab ')).toBe(false);
    expect(canSearch('rome')).toBe(true);
  });
  it('shows a placeholder, a caret and the tail of long text', () => {
    expect(displayText('', true)).toEqual({ text: SEARCH_PLACEHOLDER, placeholder: true });
    expect(displayText('rome', true).text).toBe('rome|');
    expect(displayText('x'.repeat(35), false).text).toHaveLength(28);
  });
  it('shortens result labels', () => {
    expect(resultLabel('Times Square, Manhattan, New York, United States')).toBe('Times Square, Manhattan');
    expect(resultLabel('')).toBe('Unnamed place');
  });
  it('shows only in table mode', () => {
    expect(showSearchPanel('table')).toBe(true);
    expect(showSearchPanel('street')).toBe(false);
  });
});
