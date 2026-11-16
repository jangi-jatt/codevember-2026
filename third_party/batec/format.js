// The track map: what analysis produces, the editor refines, and a sketch plays back.
//
// In memory, curves and onsets are typed arrays. Serialised, energy curves are bytes in base64
// and onsets are flat [time, strength, …] lists, rounded to the millisecond.

import { cleanBeats, MIN_BPM, MAX_BPM } from "./grid.js";

export const FORMAT_VERSION = 1;

export function createTrackMap(map) {
  return {
    version: FORMAT_VERSION,
    duration: map.duration,
    sampleRate: map.sampleRate,
    frameRate: map.frameRate,
    tempo: { bpm: 120, offset: 0, beatsPerBar: 4, mode: "grid", ...map.tempo },
    beats: map.beats || new Float64Array(0),
    bands: (map.bands || []).map((b) => ({
      name: b.name,
      kind: b.kind || "band",
      ...(b.source ? { source: b.source } : {}),
      ...(b.presence ? { presence: b.presence } : {}),
      from: b.from,
      to: b.to,
      ...(b.empty ? { empty: true } : {}),
      threshold: b.threshold ?? 0.3,
      onsets: b.onsets || { times: new Float64Array(0), strengths: new Float32Array(0) },
      energy: b.energy || new Float32Array(0),
      ...(b.novelty ? { novelty: b.novelty } : {}),
    })),
    cues: (map.cues || []).map((c) => ({ name: c.name, time: c.time })),
    regions: (map.regions || []).map((r) => ({ name: r.name, start: r.start, end: r.end })),
    sections: (map.sections || []).map((s) => ({
      label: s.label, start: s.start, end: s.end, tags: s.tags || [], character: s.character || {}, relative: s.relative || {}, measures: s.measures || {}, change: s.change ?? 0,
    })),
    character: map.character || null,
    curves: map.curves || null,
    drumExamples: map.drumExamples || {},
    ...(map.candidates ? { candidates: map.candidates } : {}),
    ...(map.source ? { source: map.source } : {}),
  };
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

export function serialize(map, { space = 0 } = {}) {
  const out = {
    batec: FORMAT_VERSION,
    ...(map.source ? { source: map.source } : {}),
    duration: round(map.duration, 3),
    sampleRate: map.sampleRate,
    frameRate: map.frameRate,
    tempo: {
      ...map.tempo,
      bpm: round(map.tempo.bpm, 4),
      offset: round(map.tempo.offset, 4),
      ...(map.tempo.segments && map.tempo.segments.length > 1
        ? { segments: map.tempo.segments.map((g) => ({ start: round(g.start, 3), bpm: round(g.bpm, 4), offset: round(g.offset, 4) })) }
        : { segments: undefined }),
    },
    beats: Array.from(map.beats, (t) => round(t, 3)),
    bands: map.bands.map((b) => {
      const onsets = [];
      for (let i = 0; i < b.onsets.times.length; i++) onsets.push(round(b.onsets.times[i], 3), round(b.onsets.strengths[i], 3));
      return {
        name: b.name,
        kind: b.kind,
        ...(b.source ? { source: b.source } : {}),
        ...(b.from !== undefined ? { from: b.from, to: b.to } : {}),
        ...(b.empty ? { empty: true } : {}),
        threshold: round(b.threshold, 3),
        onsets,
        energy: encodeBytes(b.energy),
        ...(b.presence ? { presence: b.presence.map(([a, z]) => [round(a, 2), round(z, 2)]) } : {}),
      };
    }),
    cues: map.cues.map((c) => ({ name: c.name, time: round(c.time, 3) })),
    regions: map.regions.map((r) => ({ name: r.name, start: round(r.start, 3), end: round(r.end, 3) })),
    sections: map.sections.map((s) => ({ ...s, start: round(s.start, 3), end: round(s.end, 3) })),
    ...(map.character ? { character: map.character } : {}),
    ...(map.curves ? { curves: encodeCurves(map.curves) } : {}),
    ...(map.candidates && map.candidates.length ? { candidates: map.candidates } : {}),
    ...(Object.values(map.drumExamples || {}).some((l) => l.length)
      ? { drumExamples: Object.fromEntries(Object.entries(map.drumExamples).map(([k, l]) => [k, l.map((t) => round(t, 3))])) }
      : {}),
  };
  return JSON.stringify(out, null, space);
}

export function parse(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  if (!data || data.batec === undefined) throw new Error("Not a Batec track map");
  if (data.batec > FORMAT_VERSION) throw new Error(`Track map version ${data.batec} is newer than this Batec (${FORMAT_VERSION})`);
  const duration = Number(data.duration);
  if (!(duration >= 0)) throw new Error("Track map has no duration");
  const tempo = data.tempo ? cleanTempo(data.tempo) : undefined;
  for (const g of tempo ? (tempo.segments && tempo.segments.length ? tempo.segments : [tempo]) : []) {
    if (g.bpm !== undefined && !(g.bpm >= MIN_BPM && g.bpm <= MAX_BPM)) throw new Error(`Track map tempo ${g.bpm} bpm is out of range`);
  }
  return createTrackMap({
    ...data,
    duration,
    tempo,
    beats: Float64Array.from(cleanBeats((data.beats || []).map(Number))),
    bands: (data.bands || []).map((b) => {
      const flat = b.onsets || [];
      const times = new Float64Array(flat.length >> 1), strengths = new Float32Array(flat.length >> 1);
      for (let i = 0; i < times.length; i++) {
        times[i] = flat[2 * i];
        strengths[i] = flat[2 * i + 1];
      }
      return { ...b, name: String(b.name), empty: b.empty === true, onsets: { times, strengths }, energy: decodeBytes(b.energy) };
    }),
    cues: (data.cues || []).map((c) => ({ name: String(c.name), time: Number(c.time) })),
    regions: (data.regions || []).map((r) => ({ name: String(r.name), start: Number(r.start), end: Number(r.end) })),
    sections: (data.sections || []).map((s) => ({ ...s, label: String(s.label), start: Number(s.start), end: Number(s.end), tags: (s.tags || []).map(String) })),
    ...(data.candidates ? { candidates: data.candidates.map(Number).filter(Number.isFinite) } : {}),
    curves: data.curves ? decodeCurves(data.curves) : null,
  });
}

// Numbers in the tempo as numbers, whatever the file held.
function cleanTempo(tempo) {
  const num = (v) => (v === undefined ? undefined : Number(v));
  const seg = (g) => ({ start: num(g.start), bpm: num(g.bpm), offset: num(g.offset) });
  return {
    ...tempo,
    ...(tempo.bpm !== undefined ? { bpm: num(tempo.bpm) } : {}),
    ...(tempo.offset !== undefined ? { offset: num(tempo.offset) } : {}),
    ...(tempo.beatsPerBar !== undefined ? { beatsPerBar: num(tempo.beatsPerBar) } : {}),
    ...(tempo.detected !== undefined ? { detected: tempo.detected !== false && tempo.detected !== "false" } : {}),
    ...(tempo.segments ? { segments: tempo.segments.map(seg) } : {}),
  };
}

// Character curves: 0..1 values at `rate` per second, one byte each.
function encodeCurves(curves) {
  const out = { rate: curves.rate };
  for (const k in curves) if (k !== "rate") out[k] = encodeBytes(curves[k]);
  return out;
}

function decodeCurves(curves) {
  const out = { rate: curves.rate };
  for (const k in curves) if (k !== "rate") out[k] = decodeBytes(curves[k]);
  return out;
}

function encodeBytes(curve) {
  const bytes = Uint8Array.from(curve, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decodeBytes(base64) {
  const s = atob(base64 || "");
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) / 255;
  return out;
}
