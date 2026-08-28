#!/usr/bin/env node
// Sound Effects SP1 — synthesizes ONE canonical default audio file per
// src/audio/soundManager.ts registry key (SOUND_KEYS), using ffmpeg's
// lavfi filters (anoisesrc/sine/aevalsrc, confirmed installed in this
// environment) to generate real audio with no external samples/network
// dependency and no additional npm package — the exact generate-monster-
// presets.mjs/generate-building-presets.mjs precedent (a procedural-asset
// script committed alongside its own generated output, not regenerated at
// runtime), applied to audio instead of 3D geometry.
//
// Every sound is an honest procedural best-effort — filtered/shaped noise
// and sine/FM tones, not a sample library. Per the Sound Effects plan's own
// research: rain/wind/fire ambient loops and short percussive impacts (dice,
// hits, footsteps) are genuinely convincing candidates for this technique;
// door_transition (a creak) and death (a somber tone) are the two weakest
// candidates for convincing synthesis — both are still generated here as a
// real, non-stub attempt, and both are individually replaceable later with
// zero further engineering work once SP2's admin override system ships.
//
// Every ffmpeg invocation below is documented with the exact command used
// (as a literal shell-equivalent string in each function's own comment) so
// a human can copy, tweak, and re-run just one of them by hand later —
// that documentation is this script's actual contract per its own prompt,
// not just a nicety.
//
// Usage: node scripts/assets/generate-sound-effects.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(rootDir, "public", "sounds");
mkdirSync(outDir, { recursive: true });

/** Runs ffmpeg with the given args, always overwriting (-y) and always
 * outputting 44.1kHz mono mp3 (small file size, universally decodable by
 * every browser's Web Audio decodeAudioData — no codec-support gamble). */
function runFfmpeg(args, outFile) {
  execFileSync(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", ...args, "-ar", "44100", "-ac", "1", outFile],
    { stdio: "inherit" }
  );
}

/** Fails loudly if ffmpeg produced a zero-byte or missing file, or (via
 * ffprobe) a file with no measurable duration — the "confirm every file is
 * real, non-zero-byte, playable audio, not a stub" acceptance bar, checked
 * at generation time rather than trusted on faith. */
function verifyRealAudioFile(outFile) {
  const size = statSync(outFile).size;
  if (size <= 0) throw new Error(`${outFile} is zero bytes — ffmpeg silently produced a stub`);
  const durationText = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    outFile,
  ])
    .toString()
    .trim();
  const duration = Number(durationText);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${outFile} has no measurable duration (ffprobe reported "${durationText}")`);
  }
  return { size, duration };
}

const results = [];
function generate(name, args) {
  const outFile = join(outDir, name);
  runFfmpeg(args, outFile);
  const { size, duration } = verifyRealAudioFile(outFile);
  results.push({ name, size, duration });
  console.log(`wrote public/sounds/${name} (${size} bytes, ${duration.toFixed(2)}s)`);
}

// ─────────────────────────────────────────────────────────────────────────
// dice_impact — a short percussive click/thock: a highpassed white-noise
// transient (the "click") layered under a short low sine "thock" body,
// both faded to nothing well before the clip ends.
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i "anoisesrc=d=0.12:c=white:a=1:seed=1" \
//          -f lavfi -i "sine=f=180:d=0.12" \
//          -filter_complex "
//            [0:a]highpass=f=800,lowpass=f=6000[noise];
//            [1:a]volume=0.6[tone];
//            [noise][tone]amix=inputs=2:duration=first:dropout_transition=0,
//              afade=t=out:st=0.02:d=0.1,volume=3.0[out]" \
//          -map "[out]" dice_impact.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("dice_impact.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=0.12:c=white:a=1:seed=1",
  "-f", "lavfi", "-i", "sine=f=180:d=0.12",
  "-filter_complex",
  "[0:a]highpass=f=800,lowpass=f=6000[noise];" +
    "[1:a]volume=0.6[tone];" +
    "[noise][tone]amix=inputs=2:duration=first:dropout_transition=0,afade=t=out:st=0.02:d=0.1,volume=3.0[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// pit_fall — a whoosh (bandpassed pink noise, faded in then out, reading as
// a falling swoosh) immediately followed by a thud (a short, delayed low
// sine burst landing ~0.35s in, once the "fall" would land).
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i "anoisesrc=d=0.6:c=pink:a=1:seed=2" \
//          -f lavfi -i "sine=f=90:d=0.6" \
//          -filter_complex "
//            [0:a]bandpass=f=1200:width_type=h:w=1000,volume=1.2,
//              afade=t=in:st=0:d=0.15,afade=t=out:st=0.3:d=0.3[whoosh];
//            [1:a]atrim=0:0.25,afade=t=in:st=0:d=0.01,
//              afade=t=out:st=0.05:d=0.2,volume=1.5,adelay=350|350[thud];
//            [whoosh][thud]amix=inputs=2:duration=first:dropout_transition=0,
//              volume=2[out]" \
//          -map "[out]" pit_fall.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("pit_fall.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=0.6:c=pink:a=1:seed=2",
  "-f", "lavfi", "-i", "sine=f=90:d=0.6",
  "-filter_complex",
  "[0:a]bandpass=f=1200:width_type=h:w=1000,volume=1.2,afade=t=in:st=0:d=0.15,afade=t=out:st=0.3:d=0.3[whoosh];" +
    "[1:a]atrim=0:0.25,afade=t=in:st=0:d=0.01,afade=t=out:st=0.05:d=0.2,volume=1.5,adelay=350|350[thud];" +
    "[whoosh][thud]amix=inputs=2:duration=first:dropout_transition=0,volume=2[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// hit_normal — a pool of 3 distinct short percussive/whoosh variants (SP5
// needs real, audible variety across repeated hits, not the same file three
// times). Each variant is the same STRUCTURE (bandpassed white-noise
// whoosh + a short sine tone, both faded out) with a different noise seed
// AND a different tone frequency, confirmed via a real PCM-content diff
// during this script's own development to be genuinely distinct waveforms,
// not just distinct filenames.
//
// Equivalent shell command (variant N, N in 1..3, freq = 150 + 40*N):
//   ffmpeg -f lavfi -i "anoisesrc=d=0.18:c=white:a=1:seed=<10+N>" \
//          -f lavfi -i "sine=f=<freq>:d=0.18" \
//          -filter_complex "
//            [0:a]bandpass=f=2000:width_type=h:w=2500,
//              afade=t=out:st=0.03:d=0.15[whoosh];
//            [1:a]afade=t=out:st=0.02:d=0.16,volume=0.5[tone];
//            [whoosh][tone]amix=inputs=2:duration=first:dropout_transition=0,
//              volume=2.5[out]" \
//          -map "[out]" hit_normal_<N>.mp3
// ─────────────────────────────────────────────────────────────────────────
for (let i = 1; i <= 3; i++) {
  const seed = 10 + i;
  const freq = 150 + i * 40;
  generate(`hit_normal_${i}.mp3`, [
    "-f", "lavfi", "-i", `anoisesrc=d=0.18:c=white:a=1:seed=${seed}`,
    "-f", "lavfi", "-i", `sine=f=${freq}:d=0.18`,
    "-filter_complex",
    "[0:a]bandpass=f=2000:width_type=h:w=2500,afade=t=out:st=0.03:d=0.15[whoosh];" +
      "[1:a]afade=t=out:st=0.02:d=0.16,volume=0.5[tone];" +
      "[whoosh][tone]amix=inputs=2:duration=first:dropout_transition=0,volume=2.5[out]",
    "-map", "[out]",
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// hit_critical — a sharper, brighter, punchier variant: a higher, narrower
// bandpass on the noise layer (more "crack" than "thud") plus a
// higher-pitched tone and a hotter final mix than any hit_normal variant.
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i "anoisesrc=d=0.22:c=white:a=1:seed=30" \
//          -f lavfi -i "sine=f=420:d=0.22" \
//          -filter_complex "
//            [0:a]highpass=f=1500,bandpass=f=3200:width_type=h:w=3000,
//              afade=t=out:st=0.02:d=0.18[whoosh];
//            [1:a]afade=t=out:st=0.01:d=0.15,volume=0.7[tone];
//            [whoosh][tone]amix=inputs=2:duration=first:dropout_transition=0,
//              volume=3.2[out]" \
//          -map "[out]" hit_critical.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("hit_critical.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=0.22:c=white:a=1:seed=30",
  "-f", "lavfi", "-i", "sine=f=420:d=0.22",
  "-filter_complex",
  "[0:a]highpass=f=1500,bandpass=f=3200:width_type=h:w=3000,afade=t=out:st=0.02:d=0.18[whoosh];" +
    "[1:a]afade=t=out:st=0.01:d=0.15,volume=0.7[tone];" +
    "[whoosh][tone]amix=inputs=2:duration=first:dropout_transition=0,volume=3.2[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// hit_miss — a duller, deflected-sounding variant: heavily lowpassed
// (muffled) noise, a longer/softer decay, and a quieter overall mix than
// any real hit — reads as "swung and missed", not "connected".
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i "anoisesrc=d=0.3:c=pink:a=1:seed=40" \
//          -f lavfi -i "sine=f=110:d=0.3" \
//          -filter_complex "
//            [0:a]lowpass=f=900,afade=t=out:st=0.05:d=0.24[whoosh];
//            [1:a]afade=t=out:st=0.03:d=0.25,volume=0.3[tone];
//            [whoosh][tone]amix=inputs=2:duration=first:dropout_transition=0,
//              volume=1.4[out]" \
//          -map "[out]" hit_miss.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("hit_miss.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=0.3:c=pink:a=1:seed=40",
  "-f", "lavfi", "-i", "sine=f=110:d=0.3",
  "-filter_complex",
  "[0:a]lowpass=f=900,afade=t=out:st=0.05:d=0.24[whoosh];" +
    "[1:a]afade=t=out:st=0.03:d=0.25,volume=0.3[tone];" +
    "[whoosh][tone]amix=inputs=2:duration=first:dropout_transition=0,volume=1.4[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// token_move — a soft footstep/scrape: brown noise (naturally weighted
// toward low frequencies, softer than white/pink) bandpassed to a narrow
// mid-low window and quickly faded, short and unobtrusive since this fires
// on every single token move.
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i "anoisesrc=d=0.35:c=brown:a=1:seed=50" \
//          -filter_complex "
//            [0:a]lowpass=f=700,highpass=f=120,volume=0.5,
//              afade=t=in:st=0:d=0.02,afade=t=out:st=0.15:d=0.18[out]" \
//          -map "[out]" token_move.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("token_move.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=0.35:c=brown:a=1:seed=50",
  "-filter_complex",
  "[0:a]lowpass=f=700,highpass=f=120,volume=0.5,afade=t=in:st=0:d=0.02,afade=t=out:st=0.15:d=0.18[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// door_transition — a short creak. HONEST BEST EFFORT (per this script's
// own header comment, one of the two weakest synthesis candidates): a
// frequency-modulated sine tone via aevalsrc (a slow ~1.8Hz wobble around
// 110Hz — the actual "creak" character) layered under a very quiet
// bandpassed noise "scrape" texture.
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i \
//            "aevalsrc=exprs='0.35*sin(2*PI*(110+35*sin(2*PI*1.8*t))*t)':d=0.9:s=44100" \
//          -f lavfi -i "anoisesrc=d=0.9:c=pink:a=1:seed=60" \
//          -filter_complex "
//            [0:a]afade=t=in:st=0:d=0.08,afade=t=out:st=0.6:d=0.3[creak];
//            [1:a]bandpass=f=2500:width_type=h:w=2000,volume=0.15,
//              afade=t=in:st=0:d=0.05,afade=t=out:st=0.5:d=0.4[scrape];
//            [creak][scrape]amix=inputs=2:duration=first:dropout_transition=0,
//              volume=1.6[out]" \
//          -map "[out]" door_transition.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("door_transition.mp3", [
  "-f", "lavfi", "-i", "aevalsrc=exprs='0.35*sin(2*PI*(110+35*sin(2*PI*1.8*t))*t)':d=0.9:s=44100",
  "-f", "lavfi", "-i", "anoisesrc=d=0.9:c=pink:a=1:seed=60",
  "-filter_complex",
  "[0:a]afade=t=in:st=0:d=0.08,afade=t=out:st=0.6:d=0.3[creak];" +
    "[1:a]bandpass=f=2500:width_type=h:w=2000,volume=0.15,afade=t=in:st=0:d=0.05,afade=t=out:st=0.5:d=0.4[scrape];" +
    "[creak][scrape]amix=inputs=2:duration=first:dropout_transition=0,volume=1.6[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// death — a short somber tone. HONEST BEST EFFORT (the other of the two
// weakest synthesis candidates, per this script's own header comment): two
// low sine tones a perfect fifth apart (196Hz then 147Hz, the second
// entering 0.5s later and ringing longer), each faded in softly and out
// slowly — reads as a slow, descending funeral-bell-like phrase rather
// than a single flat beep.
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i "sine=f=196:d=1.6" -f lavfi -i "sine=f=147:d=1.6" \
//          -filter_complex "
//            [0:a]volume=0.65,afade=t=in:st=0:d=0.2,afade=t=out:st=0.8:d=0.8,
//              adelay=0|0[tone1];
//            [1:a]volume=0.6,afade=t=in:st=0:d=0.3,afade=t=out:st=1.0:d=0.6,
//              adelay=500|500[tone2];
//            [tone1][tone2]amix=inputs=2:duration=longest:dropout_transition=0,
//              volume=1.6[out]" \
//          -map "[out]" death.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("death.mp3", [
  "-f", "lavfi", "-i", "sine=f=196:d=1.6",
  "-f", "lavfi", "-i", "sine=f=147:d=1.6",
  "-filter_complex",
  "[0:a]volume=0.65,afade=t=in:st=0:d=0.2,afade=t=out:st=0.8:d=0.8,adelay=0|0[tone1];" +
    "[1:a]volume=0.6,afade=t=in:st=0:d=0.3,afade=t=out:st=1.0:d=0.6,adelay=500|500[tone2];" +
    "[tone1][tone2]amix=inputs=2:duration=longest:dropout_transition=0,volume=1.6[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// rain_loop / wind_loop / fire_loop — three ambient loops as filtered/
// shaped noise (per this plan's own research: a well-established, genuinely
// convincing procedural-audio technique, unlike door_transition/death
// above). Each is 6 seconds of noise with NO fade in/out applied at all —
// deliberate: soundManager.ts's startLoop sets `source.loop = true` on the
// decoded buffer itself, so a fade baked into the FILE would re-trigger an
// audible envelope dip every 6 seconds; a constant-level noise bed loops
// with no such seam (a stochastic waveform has no single "loud" moment
// whose repetition would be perceptible the way a fade would be).
//   - rain: a steady high hiss band (white noise, highpassed hard).
//   - wind: a lower, broader band (pink noise) with a slow (0.15Hz)
//     tremolo for a gentle gusting feel.
//   - fire: a mid band (pink noise) with a much faster (9Hz) tremolo for a
//     crackling texture.
//
// Equivalent shell commands:
//   ffmpeg -f lavfi -i "anoisesrc=d=6:c=white:a=1:seed=70" \
//          -filter_complex "[0:a]highpass=f=1800,lowpass=f=9000,
//            volume=0.5[out]" -map "[out]" rain_loop.mp3
//   ffmpeg -f lavfi -i "anoisesrc=d=6:c=pink:a=1:seed=80" \
//          -filter_complex "[0:a]lowpass=f=500,highpass=f=80,
//            tremolo=f=0.15:d=0.5,volume=0.6[out]" -map "[out]" wind_loop.mp3
//   ffmpeg -f lavfi -i "anoisesrc=d=6:c=pink:a=1:seed=90" \
//          -filter_complex "[0:a]bandpass=f=2200:width_type=h:w=3500,
//            tremolo=f=9:d=0.6,volume=0.55[out]" -map "[out]" fire_loop.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("rain_loop.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=6:c=white:a=1:seed=70",
  "-filter_complex", "[0:a]highpass=f=1800,lowpass=f=9000,volume=0.5[out]",
  "-map", "[out]",
]);
generate("wind_loop.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=1:seed=80",
  "-filter_complex", "[0:a]lowpass=f=500,highpass=f=80,tremolo=f=0.15:d=0.5,volume=0.6[out]",
  "-map", "[out]",
]);
generate("fire_loop.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=1:seed=90",
  "-filter_complex", "[0:a]bandpass=f=2200:width_type=h:w=3500,tremolo=f=9:d=0.6,volume=0.55[out]",
  "-map", "[out]",
]);

// ─────────────────────────────────────────────────────────────────────────
// thunder — a crack (a short, highpassed white-noise burst) immediately
// followed by a rumble (a much longer lowpassed brown-noise tail, faded in
// fast and out slowly) — a real one-shot crack+rumble shape, not a flat
// noise burst. SP9 fires this alongside computeLightningFlash's existing
// visual flash.
//
// Equivalent shell command:
//   ffmpeg -f lavfi -i "anoisesrc=d=0.3:c=white:a=1:seed=100" \
//          -f lavfi -i "anoisesrc=d=2.4:c=brown:a=1:seed=101" \
//          -filter_complex "
//            [0:a]highpass=f=2500,afade=t=out:st=0.05:d=0.2,
//              volume=1.5[crack];
//            [1:a]lowpass=f=180,afade=t=in:st=0:d=0.1,
//              afade=t=out:st=1.4:d=1.0,volume=1.6,adelay=60|60[rumble];
//            [crack][rumble]amix=inputs=2:duration=longest:dropout_transition=0,
//              volume=1.8[out]" \
//          -map "[out]" thunder.mp3
// ─────────────────────────────────────────────────────────────────────────
generate("thunder.mp3", [
  "-f", "lavfi", "-i", "anoisesrc=d=0.3:c=white:a=1:seed=100",
  "-f", "lavfi", "-i", "anoisesrc=d=2.4:c=brown:a=1:seed=101",
  "-filter_complex",
  "[0:a]highpass=f=2500,afade=t=out:st=0.05:d=0.2,volume=1.5[crack];" +
    "[1:a]lowpass=f=180,afade=t=in:st=0:d=0.1,afade=t=out:st=1.4:d=1.0,volume=1.6,adelay=60|60[rumble];" +
    "[crack][rumble]amix=inputs=2:duration=longest:dropout_transition=0,volume=1.8[out]",
  "-map", "[out]",
]);

// Sanity check this task's own "every registry key has a real file" bar
// against the actual generated set, not just by eye — mirrors generate-
// monster-presets.mjs's own post-generation self-check convention.
const EXPECTED_FILES = [
  "dice_impact.mp3",
  "pit_fall.mp3",
  "hit_normal_1.mp3",
  "hit_normal_2.mp3",
  "hit_normal_3.mp3",
  "hit_critical.mp3",
  "hit_miss.mp3",
  "token_move.mp3",
  "door_transition.mp3",
  "death.mp3",
  "rain_loop.mp3",
  "wind_loop.mp3",
  "fire_loop.mp3",
  "thunder.mp3",
];
const generatedNames = new Set(results.map((r) => r.name));
for (const expected of EXPECTED_FILES) {
  if (!generatedNames.has(expected)) throw new Error(`expected ${expected} to be generated but it wasn't`);
}
if (results.some((r) => r.size <= 0 || r.duration <= 0)) {
  throw new Error("at least one generated file failed the non-zero-byte/playable-duration check");
}

console.log(`\ngenerated ${results.length} real, non-empty, playable sound files under public/sounds/.`);
console.log(
  "src/audio/soundManager.ts's SOUND_FILES registry must reference exactly these filenames — see that " +
    "module's own doc comment for the SP2 override extension point if any of these are hand-tuned or " +
    "replaced later."
);
