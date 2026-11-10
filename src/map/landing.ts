/**
 * The 2D landing page card: place search (Photon) and the curated list. Plain DOM, mounted
 * into document.body by the map track and hidden while an immersive session runs or when the
 * app is not in table mode.
 */
import type { CuratedSpot } from '../contracts.js';
import { createDebouncedSearch, searchPlaces, type PlaceResult } from './photon.js';

export const LANDING_CREDIT =
  'Map data © OpenStreetMap contributors · Map tiles by OpenFreeMap · Street imagery and coverage © Mapillary and its contributors · Search by Photon (komoot)';

export interface LandingCallbacks {
  /** Show this place on the table map. */
  onPreview(place: PlaceResult): void;
  /** Go straight into the street view here. */
  onEnter(place: PlaceResult): void;
}

const CSS = `
.tm-landing{position:fixed;left:16px;top:64px;z-index:1000;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 80px);
  display:flex;flex-direction:column;gap:10px;padding:16px;box-sizing:border-box;border-radius:14px;
  background:rgba(17,20,24,.88);color:#eef2f5;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  box-shadow:0 8px 32px rgba(0,0,0,.35);backdrop-filter:blur(8px);overflow:hidden}
.tm-landing[hidden]{display:none}
.tm-landing h1{margin:0;font-size:18px;font-weight:700;letter-spacing:.01em}
.tm-landing p{margin:0;color:#b9c3cc}
.tm-landing .tm-search{display:flex;gap:6px}
.tm-landing input{flex:1;min-width:0;padding:10px 12px;border-radius:9px;border:1px solid #3a434d;background:#0c0f12;color:#eef2f5;font:inherit}
.tm-landing input:focus{outline:2px solid #05cb63;outline-offset:1px}
.tm-landing button{font:inherit;cursor:pointer;border:0;border-radius:8px}
.tm-landing .tm-list{list-style:none;margin:0;padding:0;overflow:auto;display:flex;flex-direction:column;gap:4px}
.tm-landing .tm-row{display:flex;align-items:center;gap:6px}
.tm-landing .tm-place{flex:1;min-width:0;text-align:left;padding:8px 10px;background:#1d232a;color:#eef2f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-landing .tm-place:hover,.tm-landing .tm-place:focus-visible{background:#28313a}
.tm-landing .tm-go{padding:8px 10px;background:#05cb63;color:#06210f;font-weight:700;white-space:nowrap}
.tm-landing .tm-go:hover{background:#2be080}
.tm-landing .tm-label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8995a1;margin-top:4px}
.tm-landing .tm-status{min-height:1.4em;color:#9fe8bd;font-size:13px}
.tm-landing .tm-status.tm-err{color:#ff9b9b}
.tm-landing .tm-credit{font-size:11px;color:#8995a1;border-top:1px solid #2a323a;padding-top:8px}
.tm-landing .tm-credit a{color:#b9c3cc}
.tm-landing .tm-toggle{position:absolute;right:10px;top:10px;padding:4px 8px;background:transparent;color:#8995a1}
`;

export class LandingPage {
  readonly element: HTMLElement;
  private readonly style: HTMLStyleElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLUListElement;
  private readonly curated: HTMLUListElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly search;
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
    root.setAttribute('aria-label', 'Choose a place');
    root.innerHTML = `
      <button type="button" class="tm-toggle" aria-expanded="true" title="Hide">Hide</button>
      <h1>Street View Time Machine</h1>
      <div class="tm-body" style="display:flex;flex-direction:column;gap:10px;min-height:0">
        <p>Find a place, then press <b>Enter XR</b> to stand at the map table. Tap a green street to step into it.</p>
        <form class="tm-search" role="search">
          <input type="search" placeholder="Search a place, e.g. Times Square" aria-label="Search a place" autocomplete="off" />
          <button type="submit" class="tm-go">Search</button>
        </form>
        <div class="tm-status" role="status" aria-live="polite"></div>
        <ul class="tm-list tm-results" aria-label="Search results"></ul>
        <div class="tm-label">Curated places</div>
        <ul class="tm-list tm-curated" aria-label="Curated places"></ul>
        <div class="tm-credit">${LANDING_CREDIT}</div>
      </div>`;
    this.element = root;
    this.input = root.querySelector('input')!;
    this.results = root.querySelector('.tm-results')!;
    this.curated = root.querySelector('.tm-curated')!;
    this.status = root.querySelector('.tm-status')!;
    this.body = root.querySelector('.tm-body')!;
    const toggle = root.querySelector<HTMLButtonElement>('.tm-toggle')!;

    this.search = createDebouncedSearch({
      search: (q, signal) => searchPlaces(q, { fetchFn, signal }),
      onResults: (list, q) => this.showResults(list, q),
      onError: (err) => this.setStatus(`Search failed: ${err instanceof Error ? err.message : String(err)}`, true),
      onBusy: (busy) => busy && this.setStatus('Searching...'),
    });

    this.input.addEventListener('input', () => this.search.input(this.input.value));
    root.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      this.search.input(this.input.value);
      this.search.flush();
    });
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? 'none' : 'flex';
      toggle.textContent = this.collapsed ? 'Show' : 'Hide';
      toggle.setAttribute('aria-expanded', String(!this.collapsed));
    });

    this.setSpots(spots);
    document.body.appendChild(root);
  }

  setSpots(spots: CuratedSpot[]): void {
    this.curated.replaceChildren(
      ...spots.map((s) => this.row({ label: s.name, lat: s.lat, lng: s.lng })),
    );
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  /** Dev/test hook: type a query and search immediately. */
  searchNow(text: string): void {
    this.input.value = text;
    this.search.input(text);
    this.search.flush();
  }

  dispose(): void {
    this.search.cancel();
    this.element.remove();
    this.style.remove();
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('tm-err', error);
  }

  private showResults(list: PlaceResult[], query: string): void {
    this.results.replaceChildren(...list.map((p) => this.row(p)));
    if (!query) this.setStatus('');
    else if (list.length === 0) this.setStatus(`No places found for "${query}".`);
    else this.setStatus('Pick a result to show it on the table.');
  }

  private row(place: PlaceResult): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'tm-row';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'tm-place';
    name.textContent = place.label;
    name.title = `Show ${place.label} on the table map`;
    name.addEventListener('click', () => {
      this.cb.onPreview(place);
      this.setStatus(`Showing ${place.label.split(',')[0]} on the table.`);
    });
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'tm-go';
    go.textContent = 'Street view';
    go.title = `Step into the street at ${place.label}`;
    go.addEventListener('click', () => this.cb.onEnter(place));
    li.append(name, go);
    return li;
  }
}
