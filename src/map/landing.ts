/**
 * The 2D landing page: an intro card (top left) and a rail of curated places with imagery
 * (bottom) that drifts right to left. Plain DOM, mounted into document.body by the map track
 * and hidden while an immersive session runs or when the app is not in table mode.
 * Styling follows .agents/skills/xr-glass-design (glass, hairlines, violet/mint accents).
 */
import type { CuratedSpot } from '../contracts.js';
import { createDebouncedSearch, searchPlaces, type DebouncedSearch, type PlaceResult } from './photon.js';

export const LANDING_CREDIT =
  'Map data © OpenStreetMap contributors · Map tiles by OpenFreeMap · Street imagery and coverage © Mapillary and its contributors';

export interface LandingCallbacks {
  /** Show this place on the table map. */
  onPreview(place: PlaceResult): void;
  /** Go straight into the street view here. */
  onEnter(place: PlaceResult): void;
  /** Optional: base-map choice shown as a segmented control. */
  views?: {
    options: ReadonlyArray<{ id: string; label: string }>;
    current: string;
    onChange(id: string): void;
  };
  /** Optional: 3D buildings switch (tilted map with extruded buildings). */
  buildings3d?: {
    current: boolean;
    onChange(on: boolean): void;
  };
}

// Street-view glyph: a person standing inside a 360 ring. Decorative; the button carries the label.
const STREET_VIEW_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="2.2"/><path d="M12 10.5v5M9 12.5l3-2 3 2M10 20l2-4.5 2 4.5"/><path d="M4 17c-1 .8-1.5 1.6-1.5 2.5C2.5 21.4 6.8 23 12 23s9.5-1.6 9.5-3.5c0-.9-.5-1.7-1.5-2.5" stroke-width="1.4"/></svg>';

const CSS = `
.tm-landing,.tm-rail{--glass:rgba(15,18,28,.62);--hair:rgba(255,255,255,.22);--soft:rgba(255,255,255,.72);--faint:rgba(255,255,255,.45);
  --violet:#7c6cff;--mint:#2ee6d6;
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-weight:400;color:#fff}
.tm-landing[hidden],.tm-rail[hidden]{display:none}
.tm-landing button,.tm-rail button{font:inherit;color:inherit;cursor:pointer;transition:background .15s,border-color .15s,transform .15s}
.tm-landing button:focus-visible,.tm-rail button:focus-visible{outline:2px solid var(--mint);outline-offset:2px}

/* Intro card */
.tm-landing{position:fixed;left:20px;top:64px;z-index:1000;width:min(320px,calc(100vw - 40px));box-sizing:border-box;padding:18px;
  display:flex;flex-direction:column;gap:12px;border-radius:20px;background:var(--glass);border:1px solid var(--hair);
  box-shadow:0 8px 32px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12);backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4)}
.tm-landing .tm-head{display:flex;align-items:center;gap:10px}
.tm-landing h1{flex:1;min-width:0;margin:0;font-size:16px;font-weight:500;letter-spacing:.01em;line-height:1.2}
.tm-landing .tm-toggle{flex:none;padding:4px 12px;border-radius:999px;border:1px solid var(--hair);background:rgba(255,255,255,.06);color:var(--soft);font-size:12px}
.tm-landing .tm-toggle:hover{background:rgba(255,255,255,.14);color:#fff}
.tm-landing .tm-body{display:flex;flex-direction:column;gap:10px;min-height:0}
.tm-landing .tm-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;color:var(--soft);font-size:13px}
.tm-landing .tm-steps li{display:flex;gap:10px;align-items:baseline}
.tm-landing .tm-steps i{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:11px;font-weight:500;color:#fff;background:rgba(124,108,255,.35);border:1px solid rgba(124,108,255,.6)}
.tm-landing .tm-steps b{font-weight:500;color:#fff}
.tm-landing .tm-label{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--faint)}
.tm-landing .tm-views{display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--hair)}
.tm-landing .tm-views button{flex:1;padding:6px 10px;border:0;border-radius:999px;background:transparent;color:var(--soft);font-size:13px}
.tm-landing .tm-views button:hover{color:#fff;background:rgba(255,255,255,.08)}
.tm-landing .tm-views button[aria-pressed=true]{background:rgba(124,108,255,.45);color:#fff}
.tm-landing .tm-status{color:#7ff5ea;font-size:13px}
.tm-landing .tm-status:empty{display:none}
.tm-landing .tm-credit{margin-top:2px}
.tm-landing .tm-credit{font-size:10.5px;line-height:1.5;color:var(--faint)}

/* Search */
.tm-landing .tm-search{display:flex;flex-direction:column;gap:6px}
.tm-landing .tm-search input{width:100%;box-sizing:border-box;padding:9px 14px;border-radius:999px;border:1px solid var(--hair);background:rgba(255,255,255,.06);color:#fff;font:inherit;font-size:13px}
.tm-landing .tm-search input::placeholder{color:var(--faint)}
.tm-landing .tm-search input:focus-visible{outline:2px solid var(--mint);outline-offset:2px}
.tm-landing .tm-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto}
.tm-landing .tm-results:empty{display:none}
.tm-landing .tm-results li{display:flex;align-items:center;gap:4px}
.tm-landing .tm-results .tm-hit{flex:1;min-width:0;padding:7px 10px;border:0;border-radius:12px;background:transparent;text-align:left;font-size:13px;color:var(--soft)}
.tm-landing .tm-results .tm-hit:hover{background:rgba(255,255,255,.1);color:#fff}
.tm-landing .tm-results .tm-go{flex:none;width:30px;height:30px;padding:0;display:grid;place-items:center;border-radius:50%;background:rgba(124,108,255,.35);border:1px solid rgba(124,108,255,.65)}
.tm-landing .tm-results .tm-go:hover{background:rgba(124,108,255,.7)}
.tm-landing .tm-results .tm-go svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}

/* Curated rail: one line, drifting right to left; pauses on hover or keyboard focus */
.tm-rail{position:fixed;left:0;right:0;bottom:20px;z-index:1000;overflow:hidden;padding:4px 0;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 72px,#000 calc(100% - 72px),transparent);
  mask-image:linear-gradient(90deg,transparent,#000 72px,#000 calc(100% - 72px),transparent)}
.tm-rail .tm-track{list-style:none;margin:0;padding:0;display:flex;width:max-content;animation:tm-scroll var(--tm-dur,40s) linear infinite}
.tm-rail:hover .tm-track,.tm-rail:focus-within .tm-track{animation-play-state:paused}
.tm-rail .tm-card{flex:none;display:flex;align-items:center;gap:4px;margin-right:12px;padding:6px 6px 6px 4px;border-radius:20px;
  background:var(--glass);border:1px solid var(--hair);box-shadow:0 6px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.1);
  backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4)}
.tm-rail .tm-place{display:flex;flex-direction:column;gap:1px;min-width:0;padding:4px 14px 4px 14px;border:0;border-radius:16px;background:transparent;text-align:left;white-space:nowrap}
.tm-rail .tm-place:hover{background:rgba(255,255,255,.08)}
.tm-rail .tm-name{font-size:14px;font-weight:500;line-height:1.25}
.tm-rail .tm-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--soft);line-height:1.25}
.tm-rail .tm-years{padding:0 7px;border-radius:999px;font-size:11px;color:#7ff5ea;background:rgba(46,230,214,.12);border:1px solid rgba(46,230,214,.3)}
.tm-rail .tm-icon{flex:none;width:40px;height:40px;padding:0;display:grid;place-items:center;border-radius:50%;background:rgba(124,108,255,.35);border:1px solid rgba(124,108,255,.65)}
.tm-rail .tm-icon:hover{background:rgba(124,108,255,.7);transform:scale(1.06)}
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
        <button type="button" class="tm-toggle" aria-expanded="true" title="Hide">Hide</button>
      </div>
      <div class="tm-body">
        <form class="tm-search" role="search" autocomplete="off">
          <input type="search" name="q" placeholder="Search for a place…" aria-label="Search for a place" />
          <ul class="tm-results" aria-label="Search results"></ul>
        </form>
        <ol class="tm-steps">
          <li><i>1</i><span>Pick a place from the strip below.</span></li>
          <li><i>2</i><span>Press <b>Enter XR</b> to stand at the map table.</span></li>
          <li><i>3</i><span>Tap a glowing street to step into it.</span></li>
        </ol>
        <div class="tm-views-wrap" style="display:flex;flex-direction:column;gap:6px">
          <div class="tm-label">Map</div>
          <div class="tm-views" role="group" aria-label="Map view"></div>
          <div class="tm-views tm-3d" role="group" aria-label="Buildings"></div>
        </div>
        <div class="tm-status" role="status" aria-live="polite"></div>
        <div class="tm-credit">${LANDING_CREDIT}</div>
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
    const toggle = root.querySelector<HTMLButtonElement>('.tm-toggle')!;

    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? 'none' : 'flex';
      toggle.textContent = this.collapsed ? 'Show' : 'Hide';
      toggle.title = this.collapsed ? 'Show' : 'Hide';
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

    const views = this.cb.views;
    const viewsEl = root.querySelector<HTMLElement>('.tm-views')!;
    if (views) {
      for (const o of views.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = o.label;
        b.setAttribute('aria-pressed', String(o.id === views.current));
        b.addEventListener('click', () => {
          viewsEl.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          views.onChange(o.id);
        });
        viewsEl.appendChild(b);
      }
    } else {
      root.querySelector('.tm-views-wrap')!.remove();
    }
    const b3d = this.cb.buildings3d;
    const b3dEl = root.querySelector<HTMLElement>('.tm-3d');
    if (b3dEl) {
      if (!b3d) {
        b3dEl.remove();
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '3D buildings';
        btn.title = 'Tilt the table map and raise buildings off the ground';
        btn.setAttribute('aria-pressed', String(b3d.current));
        btn.addEventListener('click', () => {
          const on = btn.getAttribute('aria-pressed') !== 'true';
          btn.setAttribute('aria-pressed', String(on));
          b3d.onChange(on);
        });
        b3dEl.appendChild(btn);
      }
    }

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
    this.status.style.color = error ? '#ff8a8a' : '';
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
