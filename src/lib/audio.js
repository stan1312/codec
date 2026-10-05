// Audio envelopes ("waveforms") of videos and alignment of two videos by sound.
// Pure functions (envelope maths, correlation) work in Node for tests;
// decoding and drawing use the browser's Web Audio / canvas.

export const ENV_RATE = 100; // envelope samples per second (10 ms)

// Mono PCM (Float32Array) -> RMS envelope at ENV_RATE
export function rmsEnvelope(samples, sampleRate, rate = ENV_RATE) {
  const hop = sampleRate / rate;
  const n = Math.floor(samples.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * hop);
    const b = Math.floor((i + 1) * hop);
    let s = 0;
    for (let j = a; j < b; j++) s += samples[j] * samples[j];
    env[i] = Math.sqrt(s / Math.max(1, b - a));
  }
  return env;
}

// "Onset strength": positive jumps of log-energy. Bangs, shots, shouts and
// whistles stand out; steady crowd noise and volume differences between
// phones cancel out. This is what we correlate.
export function onsetStrength(env) {
  const out = new Float32Array(env.length);
  let prev = Math.log(1e-4 + env[0]);
  for (let i = 1; i < env.length; i++) {
    const cur = Math.log(1e-4 + env[i]);
    out[i] = Math.max(0, cur - prev);
    prev = cur;
  }
  return out;
}

// Normalised cross-correlation of b against a.
// Convention: lag L (seconds) means that the sound at time t in A is heard at
// time t - L in B, i.e. B[t - L] ~ A[t]  (B must be moved LATER by L).
// aOffset/bOffset: absolute start of each envelope in seconds (current
// alignment), so that `center` is the lag relative to the current placement.
// Search in [center - search, center + search]. Returns the best lag and the
// score (0..1) plus the second-best peak, so a weak/ambiguous match shows.
export function bestLag(a, b, rate, { aStart = 0, bStart = 0, center = 0, search = 10, window = null } = {}) {
  const fa = onsetStrength(a);
  const fb = onsetStrength(b);
  // restrict A to a window (absolute seconds) if given
  let a0 = 0;
  let a1 = fa.length;
  if (window) {
    a0 = Math.max(0, Math.floor((window[0] - aStart) * rate));
    a1 = Math.min(fa.length, Math.ceil((window[1] - aStart) * rate));
  }
  const maxL = Math.round(search * rate);
  const c = Math.round(center * rate);
  // index shift between A and B for a lag of 0: absolute t -> iA = (t - aStart)*rate, iB = (t - bStart)*rate
  const base = Math.round((aStart - bStart) * rate);
  const scores = new Float32Array(2 * maxL + 1);
  let best = -Infinity;
  let bestK = 0;
  for (let k = -maxL; k <= maxL; k++) {
    const L = c + k; // samples
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    let n = 0;
    for (let i = a0; i < a1; i++) {
      const j = i + base - L;
      if (j < 0 || j >= fb.length) continue;
      const x = fa[i];
      const y = fb[j];
      sab += x * y;
      saa += x * x;
      sbb += y * y;
      n++;
    }
    const s = n > rate && saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
    scores[k + maxL] = s;
    if (s > best) {
      best = s;
      bestK = k;
    }
  }
  // second best peak at least 0.3 s away
  const gap = Math.round(0.3 * rate);
  let second = 0;
  for (let k = -maxL; k <= maxL; k++) if (Math.abs(k - bestK) > gap) second = Math.max(second, scores[k + maxL]);
  // parabolic refinement (sub-sample)
  let frac = 0;
  const i = bestK + maxL;
  if (i > 0 && i < scores.length - 1) {
    const y0 = scores[i - 1];
    const y1 = scores[i];
    const y2 = scores[i + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) frac = (0.5 * (y0 - y2)) / d;
  }
  return { lag: (c + bestK + frac) / rate, score: Math.max(0, best), second, scores };
}

// ---------------------------------------------------------------- browser only

// Decode the audio track of a File / Blob / URL -> { env, rate, duration }
export async function decodeEnvelope(source) {
  let buf;
  if (typeof source === "string") buf = await (await fetch(source)).arrayBuffer();
  else buf = await source.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 2, 22050);
  const audio = await ctx.decodeAudioData(buf);
  // mix down to mono
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const d = audio.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i] += d[i] / audio.numberOfChannels;
  }
  return { env: rmsEnvelope(mono, audio.sampleRate), rate: ENV_RATE, duration: audio.duration };
}

// Draw an envelope as a centred waveform; returns a data: URL (for CSS backgrounds)
export function waveformDataURL(env, { width = 1200, height = 40, color = "rgba(255,255,255,0.85)", from = 0, to = env.length } = {}) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  drawWaveform(c.getContext("2d"), env, { width, height, color, from, to });
  return c.toDataURL("image/png");
}

export function drawWaveform(g, env, { width, height, color = "white", from = 0, to = env.length, x0 = 0 } = {}) {
  let max = 1e-6;
  for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i];
  g.fillStyle = color;
  const mid = height / 2;
  const span = to - from;
  for (let x = 0; x < width; x++) {
    const a = Math.floor(from + (x / width) * span);
    const b = Math.max(a + 1, Math.floor(from + ((x + 1) / width) * span));
    let v = 0;
    for (let i = Math.max(0, a); i < Math.min(env.length, b); i++) if (env[i] > v) v = env[i];
    // square root scaling keeps quiet parts visible
    const h = Math.sqrt(v / max) * (height - 2);
    if (h > 0.5) g.fillRect(x0 + x, mid - h / 2, 1, h);
  }
}
