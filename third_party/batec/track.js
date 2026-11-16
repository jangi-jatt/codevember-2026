// Plays back a track map: call update(time) every frame with the audio's current time, read the
// musical state it returns, and listen for the beats, onsets, cues and regions it crosses.

import { parse } from "./format.js";
import { buildBeats, tempoSegments, segmentIndexAt } from "./grid.js";

// A gap larger than this between updates is a seek, and fires nothing.
const MAX_STEP = 1;

export class Track {
  constructor(map, options = {}) {
    this.map = map.version ? map : parse(map);
    this.decay = options.decay ?? 0.2;
    this.listeners = new Map();
    this.lastTime = null;
    this.afterSeek = false;
    this.activeRegions = new Set();
    this.bands = {};
    for (const b of this.map.bands) this.bands[b.name] = b;
    this.setTempo(this.map.tempo);

    this.state = {
      time: 0, bpm: 0, beat: 0, beatPhase: 0, beatInBar: 0, bar: 0, barPhase: 0,
      energy: {}, pulse: {}, since: {}, regions: [], section: null, sectionProgress: 0,
      character: this.map.curves ? {} : null,
      active: {},
    };
  }

  get duration() { return this.map.duration; }

  // The whole song's character: scores, tags and measures.
  get character() { return this.map.character; }

  get sections() { return this.map.sections; }

  // Index of the section playing at `time`, or -1.
  sectionIndexAt(time) {
    const sections = this.map.sections;
    let lo = 0, hi = sections.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sections[mid].start <= time) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found >= 0 && time < sections[found].end ? found : -1;
  }

  // Changes the tempo and rebuilds the beat list. `bpm` and `offset` on their own change the
  // first tempo segment; `segments` replaces the whole tempo map.
  setTempo(tempo) {
    const t = { ...this.map.tempo };
    if (!tempo.segments && t.segments && t.segments.length && (tempo.bpm !== undefined || tempo.offset !== undefined)) {
      t.segments = [{ ...t.segments[0], ...(tempo.bpm !== undefined ? { bpm: tempo.bpm } : {}), ...(tempo.offset !== undefined ? { offset: tempo.offset } : {}) }, ...t.segments.slice(1)];
    }
    Object.assign(t, tempo);
    // validates before anything changes, so a bad tempo leaves the map as it was
    const segments = tempoSegments(t);
    if (t.segments && t.segments.length) {
      t.segments = segments;
      t.bpm = segments[0].bpm;
      t.offset = segments[0].offset;
    }
    const grid = buildBeats(t, this.map.duration, this.map.beats);
    // a tempo set by hand is no longer a placeholder
    const prev = this.segments;
    if (prev && (segments.length !== prev.length || segments.some((g, k) => g.start !== prev[k].start || g.bpm !== prev[k].bpm || g.offset !== prev[k].offset))) {
      delete t.detected;
      delete this.map.tempo.detected;
    }
    Object.assign(this.map.tempo, t);
    this.segments = segments;
    this.grid = grid;
  }

  // The tempo map as segments [{ start, bpm, offset }]; one segment when the tempo is constant.
  get tempoSegments() { return this.segments; }

  tempoIndexAt(time) { return segmentIndexAt(this.tempoSegments, time); }

  setThreshold(band, value) {
    if (!this.bands[band]) throw new Error(`No band named "${band}"`);
    this.bands[band].threshold = value;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, event) {
    const set = this.listeners.get(type);
    if (set) for (const fn of set) fn(event);
  }

  // Beats since the first downbeat, fractional. Negative before it.
  beatAt(time) {
    const { times, zero } = this.grid;
    const i = Math.min(times.length - 2, Math.max(0, upperBound(times, time) - 1));
    return i - zero + (time - times[i]) / (times[i + 1] - times[i]);
  }

  timeOfBeat(beat) {
    const { times, zero } = this.grid;
    const i = Math.min(times.length - 2, Math.max(0, Math.floor(beat) + zero));
    return times[i] + (beat + zero - i) * (times[i + 1] - times[i]);
  }

  // Time, position in the bar and bar number of whole beat `beat`, also past either end.
  beatInfo(beat) {
    const { times, inBar, bar, zero, beatsPerBar: bpb } = this.grid;
    const i = beat + zero, n = times.length;
    if (i >= 0 && i < n) return { time: times[i], beatInBar: inBar[i], bar: bar[i] };
    const edge = i < 0 ? 0 : n - 1, step = i - edge;
    const period = i < 0 ? times[1] - times[0] : times[n - 1] - times[n - 2];
    return {
      time: times[edge] + step * period,
      beatInBar: (((inBar[edge] + step) % bpb) + bpb) % bpb,
      bar: bar[edge] + Math.floor((inBar[edge] + step) / bpb),
    };
  }

  // Time of the downbeat nearest `time`; bars can be cut short where the tempo changes.
  nearestDownbeat(time) {
    const b = Math.floor(this.beatAt(time)), reach = this.grid.beatsPerBar + 1;
    let best = null;
    for (let k = b - reach; k <= b + reach + 1; k++) {
      const info = this.beatInfo(k);
      if (info.beatInBar === 0 && (best === null || Math.abs(info.time - time) < Math.abs(best - time))) best = info.time;
    }
    return best ?? time;
  }

  // `time` snapped to the nearest downbeat ("bar") or 1/`division` of a beat, kept within the song.
  snap(time, division) {
    const t = division === "bar" ? this.nearestDownbeat(time) : this.timeOfBeat(Math.round(this.beatAt(time) * division) / division);
    return Math.min(this.duration, Math.max(0, t));
  }

  // The segment's tempo on a grid; the spacing of the surrounding beats when following tracked beats.
  bpmAt(time) {
    if (this.map.tempo.mode !== "beats") return this.tempoSegments[this.tempoIndexAt(time)].bpm;
    const { times } = this.grid;
    const i = Math.min(times.length - 2, Math.max(0, upperBound(times, time) - 1));
    return 60 / (times[i + 1] - times[i]);
  }

  // The state at `time` without firing anything. The returned object is reused between calls.
  at(time) {
    const s = this.state;
    const beat = this.beatAt(time);
    const info = this.beatInfo(Math.floor(beat));
    s.time = time;
    s.bpm = this.bpmAt(time);
    s.beat = beat;
    s.beatPhase = beat - Math.floor(beat);
    s.bar = info.bar;
    s.beatInBar = info.beatInBar;
    s.barPhase = Math.min(1, (info.beatInBar + s.beatPhase) / this.grid.beatsPerBar);

    for (const b of this.map.bands) {
      s.energy[b.name] = sampleCurve(b.energy, time * this.map.frameRate);
      // stems know when they are playing at all
      if (b.presence) s.active[b.name] = b.presence.some(([a, z]) => time >= a && time < z);
      const i = this.lastOnset(b, time);
      if (i < 0) {
        s.pulse[b.name] = 0;
        s.since[b.name] = Infinity;
      } else {
        const dt = time - b.onsets.times[i];
        s.pulse[b.name] = Math.min(1, b.onsets.strengths[i]) * Math.exp(-dt / this.decay);
        s.since[b.name] = dt;
      }
    }

    s.regions.length = 0;
    for (const r of this.map.regions) if (time >= r.start && time < r.end) s.regions.push(r.name);

    // the character right now, from the curves
    const curves = this.map.curves;
    if (curves) for (const key in curves) if (key !== "rate") s.character[key] = sampleCurve(curves[key], time * curves.rate);

    const k = this.sectionIndexAt(time);
    s.section = k >= 0 ? this.map.sections[k] : null;
    s.sectionProgress = s.section ? (time - s.section.start) / (s.section.end - s.section.start) : 0;
    return s;
  }

  inRegion(name, time = this.state.time) {
    return this.map.regions.some((r) => r.name === name && time >= r.start && time < r.end);
  }

  // Index of the latest onset at or before `time` that clears the band's threshold, or -1.
  lastOnset(band, time) {
    const { times, strengths } = band.onsets;
    for (let i = upperBound(times, time) - 1; i >= 0; i--) {
      if (time - times[i] > 10 * this.decay) return -1;
      if (strengths[i] >= band.threshold) return i;
    }
    return -1;
  }

  // Advances to `time`, firing everything crossed since the previous update, and returns at(time).
  // The first update fires nothing; if it is within MAX_STEP of 0, the next one that moves forward
  // fires everything from 0 on, inclusive. After a seek, what is exactly at the landing time fires
  // on the next update.
  update(time) {
    const last = this.lastTime;
    if (time === last) return this.at(time);
    if (last === null || time < last || time - last > MAX_STEP) {
      this.seek(time);
      this.fromStart = last === null && time >= 0 && time <= MAX_STEP;
      return this.state;
    }
    this.lastTime = time;
    if (this.fromStart) {
      this.activeRegions = new Set();
      this.fire(0, time, true);
    } else {
      this.fire(last, time, this.afterSeek);
    }
    this.afterSeek = this.fromStart = false;
    return this.at(time);
  }

  // Jumps to `time` without firing anything; what is exactly there fires on the next update.
  seek(time) {
    this.lastTime = time;
    this.activeRegions = new Set(this.map.regions.filter((r) => time > r.start && time < r.end));
    this.afterSeek = true;
    this.fromStart = false;
    return this.at(time);
  }

  // Fires what lies in (from, to], or [from, to] when `landed`, as on the first frame of playback.
  fire(from, to, landed = false) {
    const after = (t) => (landed ? t >= from : t > from) && t <= to;
    const { times, zero } = this.grid;
    // an extrapolated beat can sit a rounding error before where it lands, as beat 0 does at 0
    for (let i = landed ? lowerBound(times, from - 1e-6) : upperBound(times, from); i < times.length && times[i] <= to; i++) {
      const b = i - zero;
      const event = { ...this.beatInfo(b), beat: b };
      if (event.beatInBar === 0) this.emit("bar", event);
      this.emit("beat", event);
    }

    for (const band of this.map.bands) {
      const { times, strengths } = band.onsets;
      for (let i = landed ? lowerBound(times, from) : upperBound(times, from); i < times.length && times[i] <= to; i++) {
        if (strengths[i] < band.threshold) continue;
        const event = { band: band.name, time: times[i], strength: strengths[i] };
        this.emit("onset", event);
        this.emit(`onset:${band.name}`, event);
      }
    }

    for (const band of this.map.bands) {
      if (!band.presence) continue;
      for (const [start, end] of band.presence) {
        const event = { name: band.name, start, end };
        if (after(start)) { this.emit("start", event); this.emit(`start:${band.name}`, event); }
        if (end > from && end <= to) { this.emit("stop", event); this.emit(`stop:${band.name}`, event); }
      }
    }

    for (const cue of this.map.cues) {
      if (after(cue.time)) {
        this.emit("cue", cue);
        this.emit(`cue:${cue.name}`, cue);
      }
    }

    let before = this.sectionIndexAt(from);
    if (landed && before >= 0 && this.map.sections[before].start === from) before = -1;
    const current = this.sectionIndexAt(to);
    if (current !== before && current >= 0) {
      const section = this.map.sections[current];
      const event = { ...section, index: current };
      this.emit("section", event);
      this.emit(`section:${section.label}`, event);
      for (const tag of section.tags) this.emit(`tag:${tag}`, event);
    }

    const now = new Set(this.map.regions.filter((r) => to >= r.start && to < r.end));
    for (const r of this.activeRegions) if (!now.has(r)) { this.emit("leave", r); this.emit(`leave:${r.name}`, r); }
    for (const r of now) if (!this.activeRegions.has(r)) { this.emit("enter", r); this.emit(`enter:${r.name}`, r); }
    this.activeRegions = now;
  }
}

// First index whose value is not less than x.
export function lowerBound(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// First index whose value is greater than x.
export function upperBound(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sampleCurve(curve, x) {
  if (!curve.length || x < 0) return 0;
  const i = Math.floor(x), f = x - i;
  if (i >= curve.length - 1) return curve[curve.length - 1];
  return curve[i] * (1 - f) + curve[i + 1] * f;
}
