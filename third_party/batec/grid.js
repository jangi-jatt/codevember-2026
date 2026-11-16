// The beat list every part of Batec counts with: beat times, and where each beat falls in its
// bar. Built from a tempo map (one or more constant-tempo segments) or from tracked beats.
//
// Bars are counted from the beat list, so a tempo change that lands mid-bar simply cuts that
// bar short; the next segment's downbeats start the next bar.

export const MIN_BPM = 1, MAX_BPM = 1000;

// The tempo as segments [{ start, bpm, offset }], start ascending, the first at 0. `offset` is
// the time of any downbeat of that segment's grid.
export function tempoSegments(tempo) {
  const list = tempo.segments && tempo.segments.length ? tempo.segments : [{ start: 0, bpm: tempo.bpm, offset: tempo.offset }];
  for (const s of list) if (!(s.bpm >= MIN_BPM && s.bpm <= MAX_BPM)) throw new RangeError(`Tempo must be between ${MIN_BPM} and ${MAX_BPM} bpm, got ${s.bpm}`);
  return list.map((s, i) => ({ start: i === 0 ? 0 : s.start, bpm: s.bpm, offset: s.offset }));
}

// Tracked beat times that are finite and at least 1 ms after the one kept before.
export function cleanBeats(beats) {
  const out = [];
  for (const t of beats) if (Number.isFinite(t) && (!out.length || t - out[out.length - 1] >= 1e-3)) out.push(t);
  return out;
}

// Index of the segment playing at `time`.
export function segmentIndexAt(segments, time) {
  let k = 0;
  while (k + 1 < segments.length && segments[k + 1].start <= time) k++;
  return k;
}

// { times, inBar, bar, zero }: beat times covering [-2 bars, duration + 2 bars], each beat's
// position in its bar, its bar number, and the index of beat 0 (the first downbeat at or after
// time 0, which is where bar 0 starts).
export function buildBeats(tempo, duration, trackedBeats = null) {
  const bpb = tempo.beatsPerBar || 4;
  const times = [], inBar = [];
  if (trackedBeats) trackedBeats = cleanBeats(trackedBeats);

  if (tempo.mode === "beats" && trackedBeats && trackedBeats.length > 1) {
    // the tracked beat nearest the first segment's downbeat starts a bar
    const segments = tempoSegments(tempo);
    let k = 0;
    for (let i = 1; i < trackedBeats.length; i++) if (Math.abs(trackedBeats[i] - segments[0].offset) < Math.abs(trackedBeats[k] - segments[0].offset)) k = i;
    const first = trackedBeats[1] - trackedBeats[0], last = trackedBeats[trackedBeats.length - 1] - trackedBeats[trackedBeats.length - 2];
    const before = Math.ceil((trackedBeats[0] + 2 * bpb * first) / first);
    for (let i = before; i > 0; i--) times.push(trackedBeats[0] - i * first);
    for (const t of trackedBeats) times.push(t);
    const end = duration + 2 * bpb * last;
    for (let t = trackedBeats[trackedBeats.length - 1] + last; t < end; t += last) times.push(t);
    for (let i = 0; i < times.length; i++) inBar.push((((i - (k + before)) % bpb) + bpb) % bpb);
  } else {
    const segments = tempoSegments(tempo);
    segments.forEach((s, k) => {
      const period = 60 / s.bpm;
      const from = k === 0 ? -2 * bpb * period : s.start;
      const to = k + 1 < segments.length ? segments[k + 1].start : duration + 2 * bpb * period;
      let n = Math.ceil((from - s.offset) / period - 1e-9);
      for (let t = s.offset + n * period; t < to - 1e-9; t = s.offset + ++n * period) {
        // two beats this close would be a flam; the segment that starts here owns its first beat
        if (times.length && t - times[times.length - 1] < 0.4 * period) {
          times.pop();
          inBar.pop();
        }
        times.push(t);
        inBar.push(((n % bpb) + bpb) % bpb);
      }
    });
  }

  let zero = times.findIndex((t, i) => inBar[i] === 0 && t >= -1e-6);
  if (zero < 0) zero = 0;
  const bar = new Int32Array(times.length);
  for (let i = zero + 1; i < times.length; i++) bar[i] = bar[i - 1] + (inBar[i] <= inBar[i - 1] ? 1 : 0);
  for (let i = zero - 1; i >= 0; i--) bar[i] = bar[i + 1] - (inBar[i + 1] <= inBar[i] ? 1 : 0);

  return { times: Float64Array.from(times), inBar: Uint8Array.from(inBar), bar, zero, beatsPerBar: bpb };
}
