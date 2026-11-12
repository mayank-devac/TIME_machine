/**
 * The 2D landing page: an intro card (top left) and a rail of curated places with imagery
 * (bottom) that drifts right to left. Plain DOM, mounted into document.body by the map track
 * and hidden while an immersive session runs or when the app is not in table mode.
 * Styling follows .agents/skills/xr-glass-design; colours come from `src/theme.ts`.
 * Map style and 3D buildings are chosen on the HUD's settings panel, not here.
 */
import type { CuratedSpot } from '../contracts.js';
import { cssVars, currentTokens } from '../theme.js';
import type { Tokens } from '../theme.js';
import { createDebouncedSearch, searchPlaces, type DebouncedSearch, type PlaceResult } from './photon.js';

export interface LandingCallbacks {
  /** Show this place on the table map. */
  onPreview(place: PlaceResult): void;
  /** Go straight into the street view here. */
  onEnter(place: PlaceResult): void;
}

// Street-view glyph: a person standing inside a 360 ring. Decorative; the button carries the label.
const STREET_VIEW_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="2.2"/><path d="M12 10.5v5M9 12.5l3-2 3 2M10 20l2-4.5 2 4.5"/><path d="M4 17c-1 .8-1.5 1.6-1.5 2.5C2.5 21.4 6.8 23 12 23s9.5-1.6 9.5-3.5c0-.9-.5-1.7-1.5-2.5" stroke-width="1.4"/></svg>';

// Fold chevrons for the card's hide / show toggle. Filled with the button's text colour.
const CHEVRON_UP =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>';
const CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';

/**
 * Every colour below is a `--tm-*` custom property written from the theme tokens (see
 * `cssVars` in `src/theme.ts`); translucent shades are mixed from them, never spelled out.
 */
const CSS = `
.tm-landing,.tm-rail{
  --line:color-mix(in srgb,var(--tm-border) 80%,transparent);
  --wash:color-mix(in srgb,var(--tm-surface) 70%,transparent);
  --shade:color-mix(in srgb,var(--tm-on-accent) 35%,transparent);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-weight:400;color:var(--tm-text-primary)}
.tm-landing[hidden],.tm-rail[hidden]{display:none}
.tm-landing button,.tm-rail button{font:inherit;color:inherit;cursor:pointer;transition:background .15s,border-color .15s,transform .15s}
.tm-landing button:focus-visible,.tm-rail button:focus-visible{outline:2px solid var(--tm-hover);outline-offset:2px}

/* Intro card */
.tm-landing{position:fixed;left:20px;top:64px;z-index:1000;width:min(320px,calc(100vw - 40px));box-sizing:border-box;padding:18px;
  display:flex;flex-direction:column;gap:12px;border-radius:20px;background:var(--tm-background);border:1px solid var(--line);
  box-shadow:0 8px 32px var(--shade);backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4)}
.tm-landing .tm-head{display:flex;align-items:center;gap:10px}
.tm-landing h1{flex:1;min-width:0;margin:0;font-size:16px;font-weight:500;letter-spacing:.01em;line-height:1.2}
.tm-landing .tm-toggle{flex:none;width:28px;height:28px;padding:0;display:grid;place-items:center;border-radius:50%;border:1px solid var(--line);background:var(--wash);color:var(--tm-text-secondary)}
.tm-landing .tm-toggle svg{width:20px;height:20px;fill:currentColor}
.tm-landing .tm-toggle:hover{background:var(--tm-hover-fill);border-color:var(--tm-hover);color:var(--tm-text-primary)}
.tm-landing .tm-body{display:flex;flex-direction:column;gap:10px;min-height:0}
.tm-landing .tm-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;color:var(--tm-text-secondary);font-size:13px}
.tm-landing .tm-steps li{display:flex;gap:10px;align-items:baseline}
.tm-landing .tm-steps i{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:11px;font-weight:500;color:var(--tm-on-accent);background:var(--tm-accent)}
.tm-landing .tm-steps b{font-weight:500;color:var(--tm-text-primary)}
.tm-landing .tm-status{color:var(--tm-text-primary);font-size:13px}
.tm-landing .tm-status[data-error]{color:var(--tm-text-primary);font-weight:600}
.tm-landing .tm-status:empty{display:none}
.tm-landing .tm-credit{margin-top:2px;font-size:10.5px;line-height:1.5;color:var(--tm-text-secondary)}

/* Search */
.tm-landing .tm-search{display:flex;flex-direction:column;gap:6px}
.tm-landing .tm-search input{width:100%;box-sizing:border-box;padding:9px 14px;border-radius:999px;border:1px solid var(--line);background:var(--wash);color:var(--tm-text-primary);font:inherit;font-size:13px}
.tm-landing .tm-search input::placeholder{color:var(--tm-text-secondary)}
.tm-landing .tm-search input:focus-visible{outline:2px solid var(--tm-hover);outline-offset:2px}
.tm-landing .tm-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto}
.tm-landing .tm-results:empty{display:none}
.tm-landing .tm-results li{display:flex;align-items:center;gap:4px}
.tm-landing .tm-results .tm-hit{flex:1;min-width:0;padding:7px 10px;border:0;border-radius:12px;background:transparent;text-align:left;font-size:13px;color:var(--tm-text-secondary)}
.tm-landing .tm-results .tm-hit:hover{background:var(--tm-hover-fill);color:var(--tm-text-primary)}
.tm-landing .tm-results .tm-go{flex:none;width:30px;height:30px;padding:0;display:grid;place-items:center;border-radius:50%;color:var(--tm-on-accent);background:var(--tm-accent);border:1px solid var(--tm-accent)}
.tm-landing .tm-results .tm-go:hover{border-color:var(--tm-hover);transform:scale(1.06)}
.tm-landing .tm-results .tm-go svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}

/* Curated rail: one line, drifting right to left; pauses on hover or keyboard focus */
.tm-rail{position:fixed;left:0;right:0;bottom:20px;z-index:1000;overflow:hidden;padding:4px 0;
  -webkit-mask-image:linear-gradient(90deg,transparent,black 72px,black calc(100% - 72px),transparent);
  mask-image:linear-gradient(90deg,transparent,black 72px,black calc(100% - 72px),transparent)}
.tm-rail .tm-track{list-style:none;margin:0;padding:0;display:flex;width:max-content;animation:tm-scroll var(--tm-dur,40s) linear infinite}
.tm-rail:hover .tm-track,.tm-rail:focus-within .tm-track{animation-play-state:paused}
.tm-rail .tm-card{flex:none;display:flex;align-items:center;gap:4px;margin-right:12px;padding:6px 6px 6px 4px;border-radius:20px;
  background:var(--tm-background);border:1px solid var(--line);box-shadow:0 6px 24px var(--shade);
  backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4)}
.tm-rail .tm-place{display:flex;flex-direction:column;gap:1px;min-width:0;padding:4px 14px 4px 14px;border:0;border-radius:16px;background:transparent;text-align:left;white-space:nowrap}
.tm-rail .tm-place:hover{background:var(--tm-hover-fill)}
.tm-rail .tm-name{font-size:14px;font-weight:500;line-height:1.25}
.tm-rail .tm-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--tm-text-secondary);line-height:1.25}
.tm-rail .tm-years{padding:0 7px;border-radius:999px;font-size:11px;color:var(--tm-accent);border:1px solid color-mix(in srgb,var(--tm-accent) 45%,transparent)}
.tm-rail .tm-icon{flex:none;width:40px;height:40px;padding:0;display:grid;place-items:center;border-radius:50%;color:var(--tm-on-accent);background:var(--tm-accent);border:1px solid var(--tm-accent)}
.tm-rail .tm-icon:hover{border-color:var(--tm-hover);transform:scale(1.06)}
.tm-rail .tm-icon svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
@keyframes tm-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){
  .tm-rail{overflow-x:auto;scrollbar-width:none}
  .tm-rail .tm-track{animation:none}
  .tm-rail .tm-card[aria-hidden]{display:none}
}
@media (max-width:560px){.tm-landing{left:12px;top:56px;width:calc(100vw - 24px)}.tm-rail{bottom:12px}}
`;

interface RailPlace extends PlaceResult {
  years?: number[];
}

export class LandingPage {
  readonly element: HTMLElement;
  private readonly style: HTMLStyleElement;
  private readonly curated: HTMLUListElement;
  private readonly rail: HTMLElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly credit: HTMLElement;
  private readonly search: DebouncedSearch;
  private collapsed = false;

  constructor(
    private readonly cb: LandingCallbacks,
    spots: CuratedSpot[],
    fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {
    this.style = document.createElement('style');
    this.style.textContent = CSS;
    document.head.appendChild(this.style);

    const root = document.createElement('section');
    root.className = 'tm-landing';
    root.setAttribute('aria-label', 'Street View Time Machine');
    root.innerHTML = `
      <div class="tm-head">
        <h1>Street View Time Machine</h1>
        <button type="button" class="tm-toggle" aria-expanded="true" title="Hide" aria-label="Hide">${CHEVRON_UP}</button>
      </div>
      <div class="tm-body">
        <form class="tm-search" role="search" autocomplete="off">
          <input type="search" name="q" placeholder="Search for a place…" aria-label="Search for a place" />
          <ul class="tm-results" aria-label="Search results"></ul>
        </form>
        <ol class="tm-steps">
          <li><i>1</i><span>Pick a place from the strip below.</span></li>
          <li><i>2</i><span>Explore Map</span></li>
          <li><i>3</i><span>Tap a glowing street to step into it.</span></li>
        </ol>
        <div class="tm-status" role="status" aria-live="polite"></div>
        <div class="tm-credit"></div>
      </div>`;
    this.element = root;
    this.rail = document.createElement('nav');
    this.rail.className = 'tm-rail';
    this.rail.setAttribute('aria-label', 'Curated places with street imagery');
    this.curated = document.createElement('ul');
    this.curated.className = 'tm-track';
    this.rail.appendChild(this.curated);
    this.status = root.querySelector('.tm-status')!;
    this.body = root.querySelector('.tm-body')!;
    this.credit = root.querySelector('.tm-credit')!;
    const toggle = root.querySelector<HTMLButtonElement>('.tm-toggle')!;

    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? 'none' : 'flex';
      toggle.innerHTML = this.collapsed ? CHEVRON_DOWN : CHEVRON_UP;
      toggle.title = this.collapsed ? 'Show' : 'Hide';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(!this.collapsed));
    });

    const form = root.querySelector<HTMLFormElement>('.tm-search')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    const results = form.querySelector<HTMLUListElement>('.tm-results')!;
    this.search = createDebouncedSearch({
      search: (q, signal) => searchPlaces(q, { fetchFn, signal }),
      onResults: (list, q) => {
        results.replaceChildren(...list.map((p) => this.hit(p)));
        if (q.length >= 3 && list.length === 0) this.setStatus(`No places found for "${q}".`, true);
        else this.setStatus('');
      },
      onError: () => this.setStatus('Place search failed. Check your connection and try again.', true),
      onBusy: (busy) => {
        if (busy) this.setStatus('Searching…');
      },
    });
    input.addEventListener('input', () => this.search.input(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        this.search.input('');
        this.search.flush();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.search.flush();
    });

    this.setTheme(currentTokens());
    this.setSpots(spots);
    document.body.append(root, this.rail);
  }

  setSpots(spots: CuratedSpot[]): void {
    const cards = () =>
      spots.map((s) => this.card({ label: s.name, lat: s.lat, lng: s.lng, years: s.years }));
    // Second copy makes the loop seamless (the track slides by exactly half its width).
    const copy = cards();
    copy.forEach((li) => {
      li.setAttribute('aria-hidden', 'true');
      li.querySelectorAll('button').forEach((b) => (b.tabIndex = -1));
    });
    this.curated.replaceChildren(...cards(), ...copy);
    this.curated.style.setProperty('--tm-dur', `${Math.max(24, spots.length * 5)}s`);
  }

  /** Recolour the card and the rail from a theme. */
  setTheme(t: Readonly<Tokens>): void {
    const vars = cssVars(t);
    this.element.setAttribute('style', vars);
    this.rail.setAttribute('style', vars);
  }

  /** The attribution line: who supplies the map now showing, plus the street imagery. */
  setCredit(mapCredit: string): void {
    this.credit.textContent = `${mapCredit}  ·  Street imagery © Mapillary and its contributors`;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    this.rail.hidden = !visible;
  }

  dispose(): void {
    this.search.cancel();
    this.element.remove();
    this.rail.remove();
    this.style.remove();
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.toggleAttribute('data-error', error);
  }

  /** One search result: the label shows it on the table, the round button enters the street. */
  private hit(place: PlaceResult): HTMLLIElement {
    const li = document.createElement('li');
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'tm-hit';
    name.textContent = place.label;
    name.title = `Show ${place.label} on the table map`;
    name.addEventListener('click', () => {
      this.cb.onPreview(place);
      this.setStatus(`Showing ${place.label.split(',')[0].trim()} on the table.`);
    });
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'tm-go';
    go.innerHTML = STREET_VIEW_ICON;
    go.setAttribute('aria-label', `Street view: ${place.label}`);
    go.title = `Step into the street at ${place.label}`;
    go.addEventListener('click', () => this.cb.onEnter(place));
    li.append(name, go);
    return li;
  }

  /** One place: the name opens it on the table, the round button steps into the street. */
  private card(place: RailPlace): HTMLLIElement {
    const [title, ...rest] = place.label.split(',');
    const where = rest.join(',').trim();
    const li = document.createElement('li');
    li.className = 'tm-card';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'tm-place';
    name.title = `Show ${place.label} on the table map`;
    const t = document.createElement('span');
    t.className = 'tm-name';
    t.textContent = title.trim();
    const meta = document.createElement('span');
    meta.className = 'tm-meta';
    if (where) meta.append(where);
    const ys = place.years?.filter((y) => Number.isFinite(y));
    if (ys && ys.length > 0) {
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      const chip = document.createElement('span');
      chip.className = 'tm-years';
      chip.textContent = lo === hi ? String(lo) : `${lo}–${hi}`;
      chip.title = `Imagery from ${ys.length} year${ys.length === 1 ? '' : 's'}`;
      meta.append(chip);
    }
    name.append(t, meta);
    name.addEventListener('click', () => {
      this.cb.onPreview(place);
      this.setStatus(`Showing ${title.trim()} on the table.`);
    });

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'tm-icon';
    go.innerHTML = STREET_VIEW_ICON;
    go.setAttribute('aria-label', `Street view: ${place.label}`);
    go.title = `Step into the street at ${place.label}`;
    go.addEventListener('click', () => this.cb.onEnter(place));

    li.append(name, go);
    return li;
  }
}
