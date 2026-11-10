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

export function createVoiceInput(lang = 'en-US', host: unknown = globalThis): VoiceInput {
  const w = host as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  let rec: RecognitionLike | null = null;
  return {
    supported: Ctor !== undefined,
    get listening() {
      return rec !== null;
    },
    start(handlers) {
      if (!Ctor || rec) return;
      const r = new Ctor();
      r.lang = lang;
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      let error: string | undefined;
      r.onresult = (e) => {
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
      };
      r.onend = () => {
        rec = null;
        handlers.onEnd(error);
      };
      rec = r;
      try {
        r.start();
      } catch {
        rec = null;
        handlers.onEnd('Could not start the microphone.');
      }
    },
    stop() {
      rec?.stop();
    },
  };
}
