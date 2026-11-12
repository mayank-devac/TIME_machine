/**
 * Room search: type on the panel keyboard or speak, SEARCH looks the text up, and tapping a
 * result moves the table map there. Table mode only, folded to its header until opened.
 */
import { searchPlaces } from '../map/photon.js';
import type { PlaceResult } from '../map/photon.js';
import { startsCollapsed } from './hud-logic.js';
import type { Host, PanelModule } from './host.js';
import { paintBox, paintButton, paintText } from './panel-style.js';
import {
  KEY_IDS,
  SEARCH_RESULTS,
  SEARCH_ZOOM,
  applyKey,
  canSearch,
  cleanSpoken,
  displayText,
  resultLabel,
  showSearchPanel,
} from './search-logic.js';
import { createVoiceInput } from './voice.js';

const IDLE_NOTE = 'Type a place name, then SEARCH.';

export function createSearchPanel(host: Host): PanelModule {
  const { bus, state } = host.ctx;
  const voice = createVoiceInput();
  let query = '';
  let found: PlaceResult[] = [];
  let picked = -1;
  let note = IDLE_NOTE;
  let folded = startsCollapsed('search', 'table');
  let token = 0;
  let abort: AbortController | null = null;
  let shape = '';

  const refresh = (): void => {
    const show = showSearchPanel(state.get().mode);
    host.setVisible('search', show);
    if (!show) return;

    paintBox(host.el('search', 'search-root'), 'panel');
    paintText(host.text('search', 'search-title'), 'secondary');
    const foldLabel = host.text('search', 'search-fold-label');
    foldLabel?.setProperties({ text: folded ? '+' : '-' });
    paintButton(host.el('search', 'search-fold'), foldLabel, 'control');
    host.el('search', 'search-content')?.setProperties({ display: folded ? 'none' : 'flex' });

    const shown = displayText(query, !voice.listening);
    const listeningEmpty = voice.listening && query.length === 0;
    const input = host.text('search', 'search-text');
    input?.setProperties({ text: listeningEmpty ? 'Listening...' : shown.text });
    paintText(input, shown.placeholder && !voice.listening ? 'secondary' : 'primary');
    paintBox(host.el('search', 'search-box'), 'control');

    const status = host.text('search', 'search-status');
    status?.setProperties({ text: note });
    paintText(status, 'secondary');

    const micLabel = host.text('search', 'search-mic-label');
    micLabel?.setProperties({ text: voice.listening ? 'STOP' : 'MIC' });
    paintButton(
      host.el('search', 'search-mic'),
      micLabel,
      !voice.supported ? 'disabled' : voice.listening ? 'listening' : 'control',
    );
    paintButton(host.el('search', 'search-clear'), host.text('search', 'search-clear-label'), 'control');
    paintButton(
      host.el('search', 'search-enter'),
      host.text('search', 'search-enter-label'),
      canSearch(query) ? 'primary' : 'disabled',
    );
    paintButton(host.el('search', 'search-space'), host.text('search', 'search-space-label'), 'control');
    for (const key of KEY_IDS) {
      paintButton(host.el('search', `search-key-${key}`), host.text('search', `search-key-label-${key}`), 'control');
    }

    for (let i = 0; i < SEARCH_RESULTS; i++) {
      const r = found[i];
      const row = host.el('search', `search-row-${i}`);
      const label = host.text('search', `search-row-label-${i}`);
      row?.setProperties({ display: r ? 'flex' : 'none' });
      if (!r) continue;
      label?.setProperties({ text: resultLabel(r.label) });
      paintButton(row, label, i === picked ? 'primary' : 'control');
    }

    const next = `${folded}|${found.length}`;
    if (next !== shape) {
      shape = next;
      host.resized('search');
    }
  };

  const runSearch = async (): Promise<void> => {
    if (!canSearch(query)) {
      note = 'Type at least 3 letters.';
      refresh();
      return;
    }
    const mine = ++token;
    abort?.abort();
    abort = new AbortController();
    note = 'Searching...';
    refresh();
    try {
      const list = await searchPlaces(query, { signal: abort.signal, limit: SEARCH_RESULTS });
      if (mine !== token || host.disposed) return;
      found = list;
      picked = -1;
      note = list.length > 0 ? 'Tap a result to show it on the table.' : `No places found for "${query}".`;
    } catch (err) {
      if (mine !== token || host.disposed || (err as { name?: string }).name === 'AbortError') return;
      found = [];
      picked = -1;
      note = 'Search failed. Check the connection.';
    }
    refresh();
  };

  const clear = (): void => {
    voice.stop();
    token++;
    abort?.abort();
    query = '';
    found = [];
    picked = -1;
    note = IDLE_NOTE;
    refresh();
  };

  /** One tap on a result both selects it and moves the map: there is no separate confirm. */
  const useResult = (i: number): void => {
    const r = found[i];
    if (!r) return;
    picked = i;
    bus.emit('map:flyRequested', { lat: r.lat, lng: r.lng, zoom: SEARCH_ZOOM, label: r.label });
    note = `Showing ${resultLabel(r.label).split(',')[0]} on the table.`;
    refresh();
  };

  const toggleMic = (): void => {
    if (!voice.supported) {
      note = 'Speech is not available here. Use the keys.';
      refresh();
      return;
    }
    if (voice.listening) {
      voice.stop();
      return;
    }
    note = 'Speak now...';
    voice.start({
      onText: (heard, final) => {
        query = cleanSpoken(heard);
        refresh();
        if (final) void runSearch();
      },
      onEnd: (error) => {
        if (error) note = error;
        refresh();
      },
    });
    refresh();
  };

  for (const key of [...KEY_IDS, 'SPACE']) {
    const id = key === 'SPACE' ? 'search-space' : `search-key-${key}`;
    host.control(host.el('search', id), key === 'SPACE' ? 'default' : 'dense', () => {
      query = applyKey(query, key);
      refresh();
    });
  }
  for (let i = 0; i < SEARCH_RESULTS; i++) {
    host.control(host.el('search', `search-row-${i}`), 'row', () => useResult(i));
  }
  host.control(host.el('search', 'search-enter'), 'primary', () => void runSearch());
  host.control(host.el('search', 'search-clear'), 'default', clear);
  host.control(host.el('search', 'search-mic'), 'default', toggleMic);
  host.control(host.el('search', 'search-fold'), 'default', () => {
    folded = !folded;
    refresh();
  });

  return {
    refresh,
    dispose() {
      token++;
      voice.stop();
      abort?.abort();
    },
  };
}
