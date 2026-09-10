import type { ComponentType } from 'react';

import {
  AnthropicMark,
  ClaudeMark,
  DeepgramMark,
  ElevenLabsMark,
  GeminiMark,
  GroqMark,
  MySQLMark,
  OpenAIMark,
  PostgresMark,
  QwenMark,
  SQLiteMark,
} from './brand-marks';

/**
 * Ambient background: glowing mesh orbs and large, slowly drifting brand marks
 * of the providers and databases this dashboard monitors.
 *
 * PERFORMANCE: the whole layer is `fixed` and `pointer-events-none`. The heavy
 * `blur` on the orbs therefore composites once instead of repainting as content
 * scrolls, and nothing here can intercept a click. Movement is expressed purely
 * through `transform` and `opacity`, so no frame triggers layout.
 *
 * ACCESSIBILITY: the layer is `aria-hidden`, and every mark is decorative. The
 * providers are also named in text on the sign-in card, so nothing here is the
 * sole carrier of meaning.
 *
 * Colour, base opacity and glow come from the `--glyph*` and `--orb*` tokens,
 * so the layer reads correctly in both themes from one set of markup.
 */

interface FloatingMark {
  Mark: ComponentType<{ className?: string }>;
  label: string;
  /** Tailwind positioning and size. Marks stay clear of the centred card. */
  position: string;
  /** Seconds. Staggered so the marks never drift in unison. */
  duration: number;
  delay: number;
  rotate: number;
}

const FLOATING: FloatingMark[] = [
  {
    Mark: OpenAIMark,
    label: 'openai',
    position: 'left-[5%] top-[11%] size-28 sm:size-36',
    duration: 24,
    delay: 0,
    rotate: -10,
  },
  {
    Mark: ClaudeMark,
    label: 'claude',
    position: 'right-[6%] top-[9%] size-28 sm:size-40',
    duration: 31,
    delay: -6,
    rotate: 8,
  },
  {
    Mark: PostgresMark,
    label: 'postgres',
    position: 'left-[9%] bottom-[11%] size-28 sm:size-40',
    duration: 27,
    delay: -13,
    rotate: 6,
  },
  {
    Mark: ElevenLabsMark,
    label: 'elevenlabs',
    position: 'right-[11%] bottom-[14%] size-20 sm:size-28',
    duration: 22,
    delay: -3,
    rotate: -8,
  },
  // Hidden on phones: at that width these crowd the card.
  {
    Mark: GeminiMark,
    label: 'gemini',
    position: 'left-[44%] top-[5%] size-24 hidden sm:block sm:size-32',
    duration: 29,
    delay: -18,
    rotate: 14,
  },
  {
    Mark: DeepgramMark,
    label: 'deepgram',
    position: 'right-[34%] bottom-[6%] size-24 hidden sm:block sm:size-32',
    duration: 25,
    delay: -9,
    rotate: -6,
  },
  {
    Mark: QwenMark,
    label: 'qwen',
    position: 'left-[2%] top-[48%] size-24 hidden lg:block lg:size-32',
    duration: 33,
    delay: -21,
    rotate: 4,
  },
  {
    Mark: AnthropicMark,
    label: 'anthropic',
    position: 'right-[2%] top-[42%] size-24 hidden lg:block lg:size-32',
    duration: 28,
    delay: -15,
    rotate: -10,
  },
  {
    Mark: MySQLMark,
    label: 'mysql',
    position: 'left-[26%] bottom-[3%] size-24 hidden xl:block xl:size-32',
    duration: 36,
    delay: -27,
    rotate: 7,
  },
  {
    Mark: SQLiteMark,
    label: 'sqlite',
    position: 'right-[24%] top-[26%] size-24 hidden xl:block xl:size-28',
    duration: 30,
    delay: -11,
    rotate: -5,
  },
  {
    // A wordmark, so it needs a wide slot rather than a square one.
    Mark: GroqMark,
    label: 'groq',
    position: 'left-[14%] top-[31%] h-12 w-32 hidden xl:block xl:h-14 xl:w-40',
    duration: 34,
    delay: -19,
    rotate: -4,
  },
];

/** Radial mesh orbs. Large, heavily blurred, and slowly drifting. */
const ORBS = [
  { position: '-left-32 -top-32 size-[34rem]', color: 'var(--orb-1)', duration: 38, delay: 0 },
  { position: '-right-40 top-1/4 size-[38rem]', color: 'var(--orb-2)', duration: 45, delay: -12 },
  { position: 'left-1/4 -bottom-48 size-[32rem]', color: 'var(--orb-3)', duration: 52, delay: -25 },
];

/**
 * Film grain, as a fixed layer.
 *
 * Inlined as a data URI so it costs no request, and kept at very low opacity --
 * it is there to stop the large gradient areas from banding, not to be seen.
 */
const NOISE_DATA_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

export function AmbientBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {ORBS.map((orb) => (
        <div
          key={orb.position}
          className={`absolute rounded-full blur-[110px] ${orb.position}`}
          style={{
            background: `radial-gradient(circle at center, ${orb.color}, transparent 70%)`,
            animation: `drift ${orb.duration}s cubic-bezier(0.32,0.72,0,1) ${orb.delay}s infinite`,
          }}
        />
      ))}

      {FLOATING.map(({ Mark, label, position, duration, delay, rotate }) => (
        <div
          key={label}
          className={`absolute ${position}`}
          style={{
            color: 'var(--glyph)',
            opacity: 'var(--glyph-opacity)',
            // Two layers: a tight core bloom plus a wide halo, which reads as
            // lit rather than as a single flat blur.
            filter:
              'drop-shadow(0 0 10px var(--glyph-glow)) drop-shadow(0 0 42px var(--glyph-glow))',
            animation: `drift ${duration}s cubic-bezier(0.32,0.72,0,1) ${delay}s infinite, pulse-glow ${duration / 2.5}s ease-in-out ${delay}s infinite`,
            rotate: `${rotate}deg`,
          }}
        >
          <Mark className="size-full" />
        </div>
      ))}

      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{ backgroundImage: NOISE_DATA_URI }}
      />
    </div>
  );
}
