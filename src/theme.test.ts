import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  HOVER,
  contrast,
  cssVars,
  currentTheme,
  currentTokens,
  hexAlpha,
  hexNumber,
  mix,
  onThemeChange,
  opaque,
  setTheme,
  tokens,
  withAlpha,
} from './theme.js';
import type { TokenName } from './theme.js';

const ROOT = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const COLOUR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|\b0x[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(|\bColor\(\s*[\d.]/u;

describe('palette', () => {
  it('has the same tokens in both themes, all valid hex', () => {
    const dark = tokens('dark');
    const light = tokens('light');
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const t of [dark, light]) {
      for (const k of Object.keys(t) as TokenName[]) expect(t[k]).toMatch(/^#[0-9A-F]{6}([0-9A-F]{2})?$/u);
    }
  });

  it('keeps text readable on every surface it sits on (WCAG AA, 4.5:1)', () => {
    for (const name of ['dark', 'light'] as const) {
      const t = tokens(name);
      expect(contrast(t.textPrimary, t.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.textPrimary, t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.textSecondary, t.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.textSecondary, t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.textPrimary, t.hoverFill)).toBeGreaterThanOrEqual(4.5);
      // Outlines and state colours only need to be seen, not read (3:1).
      expect(contrast(t.hover, t.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(t.accent, t.surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it('colour helpers', () => {
    expect(hexNumber('#FF7A45')).toBe(0xff7a45);
    expect(hexNumber('#0B1220E6')).toBe(0x0b1220);
    expect(hexAlpha('#0B1220E6')).toBeCloseTo(0.9, 2);
    expect(hexAlpha('#FFFFFF')).toBe(1);
    expect(opaque('#0B1220E6')).toBe('#0B1220');
    expect(withAlpha('#16213A', 0.5)).toBe('#16213A80');
    expect(withAlpha('#0B1220E6', 1)).toBe('#0B1220FF');
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mix('#102030', '#FFFFFF', 0)).toBe('#102030');
    expect(cssVars(tokens('dark'))).toContain('--tm-text-primary:#FFFFFF');
    expect(cssVars(tokens('dark'))).toContain('--tm-hover-fill:');
  });

  it('switches theme and tells listeners once', () => {
    expect(currentTheme()).toBe('dark');
    const fn = vi.fn();
    const off = onThemeChange(fn);
    setTheme('light');
    setTheme('light'); // no change, no call
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(tokens('light'), 'light');
    expect(currentTokens()).toBe(tokens('light'));
    off();
    setTheme('dark');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('only the dense, row and toggle hovers skip the scale-up', () => {
    const still = Object.entries(HOVER)
      .filter(([, spec]) => spec.scale === 1)
      .map(([name]) => name)
      .sort();
    expect(still).toEqual(['dense', 'row', 'toggle']);
    expect(HOVER.default).toEqual({ scale: 1.04, outline: true, fill: 'keep' });
  });
});

describe('no hardcoded colours outside src/theme.ts', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public', 'ui'))]
    .map((f) => relative(ROOT, f).split('\\').join('/'))
    .filter((f) => /\.(ts|uikitml)$/u.test(f))
    .filter((f) => !f.endsWith('.test.ts') && f !== 'src/theme.ts');

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no colour literal in any other file', () => {
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(join(ROOT, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (COLOUR.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
