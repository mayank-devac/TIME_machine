/**
 * Speech to text through the browser's Web Speech API. It is not available everywhere (Firefox has
 * none; whether the Quest Browser offers it inside an immersive session is untested), so callers
 * must check `supported` and keep a typing fallback. Chrome-based browsers send the audio to a
 * speech service run by the browser vendor.
 */
interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart?: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

export interface VoiceHandlers {
  /** Partial text while talking (`final` false) and the finished phrase (`final` true). */
  onText(text: string, final: boolean): void;
  /** Listening stopped. `error` is a short human message when it stopped because of a problem. */
  onEnd(error?: string): void;
}

export interface VoiceInput {
  readonly supported: boolean;
  readonly listening: boolean;
  start(handlers: VoiceHandlers): void;
  stop(): void;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone blocked. Allow it for this site, or type instead.',
  'service-not-allowed': 'Speech service blocked. Type instead.',
  'no-speech': 'Heard nothing. Try again.',
  'audio-capture': 'No microphone found. Type instead.',
  network: 'Speech needs a network connection.',
};

/** Errors that will not go away by trying again this visit: hide the mic after one. */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

export interface VoiceTimings {
  /** No audio within this long after start: the mic never opened (common inside VR), ms. */
  startTimeoutMs: number;
  /** Stop listening after this long whatever happens, ms. */
  maxListenMs: number;
}

export const DEFAULT_VOICE_TIMINGS: VoiceTimings = { startTimeoutMs: 5000, maxListenMs: 12000 };

type TimerHost = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export function createVoiceInput(
  lang = 'en-US',
  host: unknown = globalThis,
  timings: VoiceTimings = DEFAULT_VOICE_TIMINGS,
): VoiceInput {
  const w = host as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } & Partial<TimerHost>;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const setT = w.setTimeout?.bind(host) ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = w.clearTimeout?.bind(host) ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let rec: RecognitionLike | null = null;
  /** Set after a fatal error: the button shows NO MIC for the rest of the visit. */
  let broken = false;
  return {
    get supported() {
      return Ctor !== undefined && !broken;
    },
    get listening() {
      return rec !== null;
    },
    start(handlers) {
      if (!Ctor || rec || broken) return;
      const r = new Ctor();
      r.lang = lang;
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      let error: string | undefined;
      let heardAudio = false;
      let ended = false;
      const timers: unknown[] = [];
      // Quest Browser may accept start() inside an immersive session and then never open the
      // mic or never call onend. Watchdogs make sure the panel always comes back.
      const finish = (why?: string): void => {
        if (ended) return;
        ended = true;
        timers.forEach((t) => clearT(t));
        rec = null;
        handlers.onEnd(why);
      };
      timers.push(
        setT(() => {
          if (heardAudio || ended) return;
          error = 'The microphone did not start. Type instead.';
          try {
            r.abort();
          } catch {
            /* ignore */
          }
          finish(error);
        }, timings.startTimeoutMs),
        setT(() => {
          if (ended) return;
          try {
            r.stop();
          } catch {
            /* ignore */
          }
          // Give onend a moment; force it if it never comes.
          timers.push(setT(() => finish(error), 1500));
        }, timings.maxListenMs),
      );
      r.onaudiostart = () => {
        heardAudio = true;
      };
      r.onresult = (e) => {
        heardAudio = true;
        let text = '';
        let final = false;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
          final = e.results[i].isFinal;
        }
        handlers.onText(text, final);
      };
      r.onerror = (e) => {
        error = ERRORS[e.error ?? ''] ?? `Speech failed (${e.error ?? 'unknown'}).`;
        if (FATAL.has(e.error ?? '')) broken = true;
      };
      r.onend = () => finish(error);
      rec = r;
      try {
        r.start();
      } catch {
        broken = true;
        finish('Could not start the microphone. Type instead.');
      }
    },
    stop() {
      try {
        rec?.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}
