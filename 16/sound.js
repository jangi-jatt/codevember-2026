// Sound: a drone bed and the colony's own sounds, all synthesized but the bed.
//
// The bed is sound/sound.mp3 time-stretched 10x, keeping its pitch: short overlapping grains are read from a point that
// creeps through the track at a tenth of real time, each slightly jittered so they don't phase, and summed under smooth
// windows (it loops). It plays as plain stereo.
//
// Everything else is made from filtered noise and sines and placed in 3D (HRTF) at the world point it comes from, with
// the listener at the camera, so it comes from its side of the colony and moves as the camera does: the swells breathe
// a low rush, a sporulation burst crackles, a bud pinching off gulps, hovering rustles, a puff bursts, gathering builds
// a low rush and a fling whooshes. Around them, the room clicks and clacks now and then, always from behind the
// listener. A compressor holds them together.
//
// Downloaded and decoded while the page loads; the AudioContext is created on load and runs at once if the browser
// allows it, otherwise on the first gesture. Variation uses nativeRandom, so the seeded layout never shifts.
import { fetchWithProgress } from "common";
import { nativeRandom } from "modules/random.js";

const STRETCH = 10;
const GRAIN = 0.5;
const OVERLAP = 4;
const INTERVAL = GRAIN / OVERLAP;
const AHEAD = 0.3;

// A Hann window; OVERLAP of them summed hold steady at OVERLAP / 2.
const WINDOW = Float32Array.from({ length: 128 }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 127));
const rand = (a, b) => a + (b - a) * nativeRandom();
const coarse = matchMedia("(pointer: coarse)").matches;

export function createSound({ url = new URL("./sound/sound.mp3", import.meta.url).href, onProgress, volume = 0.7, bed = 0.55 } = {}) {
  let ctx = null, master = null, bedGain = null, fx = null, reverb = null, noise = null, buffer = null;
  let lastCamera = null;
  let on = true, paused = false, next = 0, position = 0, nextClick = 0, listenerRight = [1, 0, 0];
  // Layers that can be muted to hear the rest on their own (the ?soundtest panel): the bed, the swarm, the room's clicks,
  // and the colony's own events (swells, bursts, buds).
  const mute = { bed: false, swarm: false, room: false, life: false };
  let testing = false;
  let stretchVoice = null, stirVoice = null, gatherVoice = null, swarmSand = null, swarmSand2 = null, swarmMurmur = null, swarmRumble = null;
  const data = fetchWithProgress(url, onProgress).then((r) => r.arrayBuffer());
  data.catch(() => {});

  async function start() {
    ctx = new AudioContext();
    if (paused) ctx.suspend();
    master = ctx.createGain();
    master.gain.value = on ? volume : 0;
    master.connect(ctx.destination);
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    compressor.connect(master);
    bedGain = ctx.createGain();
    bedGain.gain.value = bed;
    bedGain.connect(compressor);
    // The colony's sounds and the room's: driven into a soft saturation, then muffled, so they come out low, rough and
    // dull, as if through the mass itself.
    fx = ctx.createGain();
    fx.gain.value = 2.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(3 * ((i / 1023) * 2 - 1)));
    shaper.oversample = "4x";
    const muffle = ctx.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 700;
    muffle.Q.value = 0.5;
    const trim = ctx.createGain();
    trim.gain.value = 0.45;
    fx.connect(shaper).connect(muffle).connect(trim).connect(compressor);
    // A large room: five seconds of decaying stereo noise as the impulse response.
    reverb = ctx.createConvolver();
    const length = Math.round(ctx.sampleRate * 5);
    const ir = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < length; i++) d[i] = (nativeRandom() * 2 - 1) * Math.pow(1 - i / length, 2.5);
    }
    reverb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    const dark = ctx.createBiquadFilter();
    dark.type = "lowpass";
    dark.frequency.value = 900;
    reverb.connect(dark).connect(wet).connect(compressor);
    // Two seconds of white noise, the source of every synthesized sound.
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const n = noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = nativeRandom() * 2 - 1;
    // Sand: dense random ticks of every size, looped, so filtered it seethes like countless grains shifting.
    const sand = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = sand.getChannelData(0);
    for (let i = 0; i < d.length; i++) if (nativeRandom() < 0.02) for (let k = 0, a = (nativeRandom() * 2 - 1) * Math.pow(nativeRandom(), 2); k < 80 && i + k < d.length; k++) d[i + k] += a * Math.exp(-k / 12);
    // Two seethes either side of the bulk for width, a murmur under them and a low rumble.
    swarmSand = sustained(450, 0.6, "bandpass", sand);
    swarmSand2 = sustained(360, 0.6, "bandpass", sand);
    swarmMurmur = sustained(180, 0.8, "bandpass");
    swarmRumble = sustained(60, 0.7, "lowpass");
    stirVoice = sustained(450, 1.2, "bandpass");
    // Stretching: a resonant band of noise, creaking through a slow flutter.
    stretchVoice = sustained(120, 4, "bandpass");
    const creak = ctx.createOscillator();
    creak.frequency.value = 13;
    const creakDepth = ctx.createGain();
    creakDepth.gain.value = 0.5;
    const creakGain = ctx.createGain();
    creakGain.gain.value = 0.5;
    stretchVoice.level.disconnect();
    stretchVoice.level.connect(creakGain).connect(stretchVoice.node);
    creak.connect(creakDepth).connect(creakGain.gain);
    creak.start();
    stretchVoice.creak = creak;
    gatherVoice = sustained(90, 0.7, "lowpass");
    try {
      buffer = await ctx.decodeAudioData((await data).slice(0));
    } catch (e) {
      console.warn("sound unavailable", e);
    }
  }
  start();
  const resume = () => {
    if (ctx && ctx.state === "suspended" && !paused) ctx.resume();
  };
  for (const e of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(e, resume, { capture: true });

  const live = () => !!ctx && ctx.state === "running" && on;
  const lively = () => live() && (testing || !mute.life);

  // A 3D source at a world point, with its direct sound (dry) and a send to the room's reverb (wet).
  function panner(p, dry = 1, wet = 0.2) {
    const node = ctx.createPanner();
    // HRTF on desktops; the cheaper equal-power panning on phones (the always-on voices are many).
    node.panningModel = coarse ? "equalpower" : "HRTF";
    node.distanceModel = "inverse";
    node.refDistance = 4;
    node.rolloffFactor = 1;
    setPosition(node, p);
    const direct = ctx.createGain();
    direct.gain.value = dry;
    node.connect(direct).connect(fx);
    const send = ctx.createGain();
    send.gain.value = wet;
    node.connect(send).connect(reverb);
    return node;
  }
  function setPosition(node, p) {
    if (node.positionX) {
      const t = ctx.currentTime;
      node.positionX.setTargetAtTime(p.x, t, 0.05);
      node.positionY.setTargetAtTime(p.y, t, 0.05);
      node.positionZ.setTargetAtTime(p.z, t, 0.05);
    } else node.setPosition(p.x, p.y, p.z);
  }
  // Noise through a filter, from when for duration seconds (looping for longer ones).
  function noiseSource(when, duration) {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.start(when, rand(0, noise.duration));
    source.stop(when + duration);
    return source;
  }
  // A continuous noise voice (stirring, gathering) whose level and place follow the pointer.
  function sustained(frequency, q, type, sourceBuffer = noise) {
    const source = ctx.createBufferSource();
    source.buffer = sourceBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const level = ctx.createGain();
    level.gain.value = 0;
    const node = panner({ x: 0, y: 0, z: 0 });
    source.connect(filter).connect(level).connect(node);
    source.start(0, rand(0, sourceBuffer.duration));
    return { filter, level, node };
  }

  function grain(when) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const envelope = ctx.createGain();
    envelope.gain.value = 0;
    envelope.gain.setValueCurveAtTime(WINDOW.map((w) => (w * 2) / OVERLAP), when, GRAIN);
    source.connect(envelope).connect(bedGain);
    const jitter = (nativeRandom() - 0.5) * 0.08;
    const offset = (((position + jitter) % buffer.duration) + buffer.duration) % (buffer.duration - GRAIN);
    source.start(when, offset, GRAIN);
    source.onended = () => envelope.disconnect();
  }

  // The room: a click or clack (sometimes two or three in quick succession) somewhere behind the listener, a few metres
  // off: a short knock of filtered noise over a damped resonance, like a small, hard thing ticking.
  function clacks(p, f, u) {
    const r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
    const back = rand(2, 7), side = rand(-5, 5), lift = rand(-2, 3);
    const at = { x: p[0] - f[0] * back + r[0] * side + u[0] * lift, y: p[1] - f[1] * back + r[1] * side + u[1] * lift, z: p[2] - f[2] * back + r[2] * side + u[2] * lift };
    // Faint and far: mostly the room's reverb, a little of the knock itself.
    const node = panner(at, 0.12, 1.6);
    const tone = rand(80, 320);
    const hits = nativeRandom() < 0.35 ? Math.round(rand(2, 3)) : 1;
    let when = ctx.currentTime + 0.02;
    for (let i = 0; i < hits; i++) {
      const level = rand(0.06, 0.15) * (i ? 0.7 : 1);
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = tone * rand(1.4, 2);
      filter.Q.value = 4;
      const env = ctx.createGain();
      env.gain.setValueAtTime(level, when);
      env.gain.exponentialRampToValueAtTime(0.001, when + 0.02);
      noiseSource(when, 0.02).connect(filter).connect(env).connect(node);
      const osc = ctx.createOscillator();
      osc.frequency.value = tone * rand(0.97, 1.03);
      const ring = ctx.createGain();
      ring.gain.setValueAtTime(level * 0.5, when);
      ring.gain.exponentialRampToValueAtTime(0.001, when + rand(0.06, 0.15));
      osc.connect(ring).connect(node);
      osc.start(when);
      osc.stop(when + 0.2);
      when += rand(0.1, 0.25);
    }
  }

  // An impact: a low thump falling in pitch, at level, stretched by length.
  function impact(node, t, level, length) {
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(70, t);
    thump.frequency.exponentialRampToValueAtTime(30, t + 0.5 * length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.04);
    env.gain.setTargetAtTime(0, t + 0.08, 0.2 * length);
    thump.connect(env).connect(node);
    thump.start(t);
    thump.stop(t + 1.5 * length);
  }

  function fadeTo(v) {
    if (!master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(v, t, 0.3);
  }

  return {
    loaded: data,
    // Schedules the bed's grains due in the next moment and puts the listener at the camera; call every frame.
    update(camera) {
      lastCamera = camera;
      if (!ctx || ctx.state !== "running") return;
      const l = ctx.listener, e = camera.matrixWorld.elements, t = ctx.currentTime;
      const p = [e[12], e[13], e[14]], f = [-e[8], -e[9], -e[10]], u = [e[4], e[5], e[6]];
      listenerRight = [e[0], e[1], e[2]];
      if (l.positionX) {
        [l.positionX, l.positionY, l.positionZ].forEach((a, i) => a.setTargetAtTime(p[i], t, 0.03));
        [l.forwardX, l.forwardY, l.forwardZ].forEach((a, i) => a.setTargetAtTime(f[i], t, 0.03));
        [l.upX, l.upY, l.upZ].forEach((a, i) => a.setTargetAtTime(u[i], t, 0.03));
      } else {
        l.setPosition(...p);
        l.setOrientation(...f, ...u);
      }
      if (on && !mute.room && t >= nextClick) {
        clacks(p, f, u);
        nextClick = t + rand(0.4, 3.5);
      }
      if (!buffer) return;
      if (next < t) next = t + 0.05;
      for (; next < t + AHEAD; next += INTERVAL) {
        grain(next);
        position = (position + INTERVAL / STRETCH) % buffer.duration;
      }
    },
    // A swell: a low rush rising over rise seconds and sagging over fall, at a point on the colony.
    pulse(amp, rise, fall, at) {
      if (!lively()) return;
      const t = ctx.currentTime;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = rand(70, 140);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.35 * amp, t + rise + 0.05);
      env.gain.setTargetAtTime(0, t + rise + 0.05, fall * 0.6);
      noiseSource(t, rise + fall * 4).connect(filter).connect(env).connect(panner(at));
    },
    // A sporulation burst: a scatter of tiny pops over half a second, round a point.
    burst(at) {
      if (!lively()) return;
      const t = ctx.currentTime;
      const node = panner(at);
      const count = Math.round(rand(10, 18));
      for (let i = 0; i < count; i++) {
        const when = t + Math.pow(nativeRandom(), 1.6) * 0.5;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = rand(350, 1300);
        filter.Q.value = 6;
        const env = ctx.createGain();
        env.gain.setValueAtTime(rand(0.25, 0.7), when);
        env.gain.exponentialRampToValueAtTime(0.001, when + rand(0.006, 0.02));
        noiseSource(when, 0.03).connect(filter).connect(env).connect(node);
      }
    },
    // A bud pinching off: a low, soft gulp.
    bud(at) {
      if (!lively()) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(rand(55, 75), t);
      osc.frequency.exponentialRampToValueAtTime(rand(28, 36), t + 0.45);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.22, t + 0.06);
      env.gain.setTargetAtTime(0, t + 0.12, 0.15);
      osc.connect(env).connect(panner(at));
      osc.start(t);
      osc.stop(t + 1);
    },
    // A puff: the impact, a low thump falling in pitch.
    puff(at) {
      if (!live()) return;
      impact(panner(at, 1, 0.35), ctx.currentTime, 0.22, 1);
    },
    // The swarm transforming, for duration seconds (the same sound each time, only its length changing): a low "whoomph",
    // then a deep, unpitched groan of noise whose filter opens while the mass reorganizes and closes as it settles,
    // under a slow tremolo, over a cascade of soft low ticks (spores tumbling into new places) that thickens mid-change.
    transform(duration, at) {
      if (!live()) return;
      const t = ctx.currentTime, end = t + duration;
      const node = panner(at, 1, 0.5);
      impact(node, t, 0.34, 1.7);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.7;
      filter.frequency.setValueAtTime(70, t);
      filter.frequency.linearRampToValueAtTime(320, t + duration * 0.45);
      filter.frequency.linearRampToValueAtTime(80, end);
      const tremolo = ctx.createGain();
      tremolo.gain.value = 0.7;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 3.5;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.3;
      lfo.connect(lfoDepth).connect(tremolo.gain);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.22, t + Math.min(0.8, duration * 0.2));
      env.gain.setValueAtTime(0.22, t + duration * 0.55);
      env.gain.linearRampToValueAtTime(0, end);
      filter.connect(tremolo).connect(env).connect(node);
      // Unpitched: deep noise, so it groans without notes.
      noiseSource(t, duration + 0.2).connect(filter);
      lfo.start(t);
      lfo.stop(end + 0.1);

      const ticks = Math.round(duration * 14);
      for (let i = 0; i < ticks; i++) {
        // Thickest in the middle of the change.
        const u = (nativeRandom() + nativeRandom() + nativeRandom()) / 3;
        const when = t + 0.2 + u * (duration - 0.3);
        const tick = ctx.createBiquadFilter();
        tick.type = "bandpass";
        tick.frequency.value = rand(300, 380);
        tick.Q.value = 5;
        const tickEnv = ctx.createGain();
        tickEnv.gain.setValueAtTime(rand(0.05, 0.07), when);
        tickEnv.gain.exponentialRampToValueAtTime(0.001, when + 0.025);
        noiseSource(when, 0.05).connect(tick).connect(tickEnv).connect(node);
      }
    },
    // A fling: a whoosh sweeping up, harder the longer it gathered.
    fling(power, at) {
      if (!live()) return;
      const t = ctx.currentTime;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.Q.value = 1.5;
      filter.frequency.setValueAtTime(110, t);
      filter.frequency.exponentialRampToValueAtTime(900, t + 0.45);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.15 * power, t + 0.08);
      env.gain.setTargetAtTime(0, t + 0.2, 0.15);
      noiseSource(t, 0.9).connect(filter).connect(env).connect(panner(at));
    },
    // The swarm moving, constantly: a seethe of grains over a low rumble, as loud as the colony is lively (0..1), at its
    // bulk; swell (0..1) lifts it with each pulse.
    swarm(level, swell, at) {
      if (!swarmSand) return;
      const t = ctx.currentTime, l = live() && !mute.swarm ? level : 0;
      for (const [voice, f] of [[swarmSand, 1], [swarmSand2, 0.8]]) {
        voice.level.gain.setTargetAtTime(0.14 * l * (1 + 0.7 * swell), t, 0.3);
        voice.filter.frequency.setTargetAtTime(f * (300 + 220 * l + 160 * swell), t, 0.3);
      }
      swarmMurmur.level.gain.setTargetAtTime(0.1 * l * (0.7 + 0.6 * swell), t, 0.3);
      swarmRumble.level.gain.setTargetAtTime(0.18 * l * (0.6 + swell), t, 0.3);
      // The two seethes a little either side of the bulk, along the listener's right.
      const e = listenerRight;
      setPosition(swarmSand.node, { x: at.x + e[0] * 0.9, y: at.y + e[1] * 0.9, z: at.z + e[2] * 0.9 });
      setPosition(swarmSand2.node, { x: at.x - e[0] * 0.9, y: at.y - e[1] * 0.9, z: at.z - e[2] * 0.9 });
      setPosition(swarmMurmur.node, at);
      setPosition(swarmRumble.node, at);
    },
    // Stretching a colony: a creaking, wet stretch as loud as the pull is fast (0..1), higher as it is stretched further
    // (tension 0..1), at the pointer.
    stretch(level, tension, at) {
      if (!stretchVoice) return;
      const t = ctx.currentTime;
      stretchVoice.level.gain.setTargetAtTime(live() ? 0.5 * level : 0, t, 0.06);
      stretchVoice.filter.frequency.setTargetAtTime(80 + 220 * tension, t, 0.1);
      stretchVoice.creak.frequency.setTargetAtTime(9 + 12 * tension, t, 0.1);
      if (level > 0.01) setPosition(stretchVoice.node, at);
    },
    // Grabbing a colony: a small thump as the spores come unstuck.
    unstick(at) {
      if (!live()) return;
      impact(panner(at, 1, 0.3), ctx.currentTime, 0.1, 0.6);
    },
    // Colonies parting: a slow, low tearing, a rumble under dense crackle.
    part(at) {
      if (!live()) return;
      const t = ctx.currentTime;
      const node = panner(at, 1, 0.5);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(380, t);
      filter.frequency.exponentialRampToValueAtTime(110, t + 1.2);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.16, t + 0.25);
      env.gain.setTargetAtTime(0, t + 0.5, 0.3);
      noiseSource(t, 1.8).connect(filter).connect(env).connect(node);
      for (let i = 0; i < 24; i++) {
        const when = t + Math.pow(nativeRandom(), 0.8) * 1.1;
        const tick = ctx.createBiquadFilter();
        tick.type = "bandpass";
        tick.frequency.value = rand(200, 520);
        tick.Q.value = 5;
        const tickEnv = ctx.createGain();
        tickEnv.gain.setValueAtTime(rand(0.06, 0.16), when);
        tickEnv.gain.exponentialRampToValueAtTime(0.001, when + rand(0.015, 0.035));
        noiseSource(when, 0.05).connect(tick).connect(tickEnv).connect(node);
      }
    },
    // Colonies fusing: a soft, wet merge, a gentle thump and a short low swell.
    fuse(at) {
      if (!live()) return;
      const t = ctx.currentTime;
      const node = panner(at, 1, 0.5);
      impact(node, t, 0.14, 1.3);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 160;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.2, t + 0.3);
      env.gain.setTargetAtTime(0, t + 0.4, 0.25);
      noiseSource(t, 1.6).connect(filter).connect(env).connect(node);
    },
    // Hovering: a rustle as loud as the stir (0..1), at the pointer.
    stir(level, at) {
      if (!stirVoice) return;
      stirVoice.level.gain.setTargetAtTime(live() ? 0.12 * level : 0, ctx.currentTime, 0.08);
      if (level > 0.01) setPosition(stirVoice.node, at);
    },
    // Gathering: a low rush building with the charge (0..1), at the point gathered to.
    gather(level, at) {
      if (!gatherVoice) return;
      const t = ctx.currentTime;
      gatherVoice.level.gain.setTargetAtTime(live() ? 0.3 * level : 0, t, 0.1);
      gatherVoice.filter.frequency.setTargetAtTime(80 + 280 * level, t, 0.1);
      if (level > 0.01) setPosition(gatherVoice.node, at);
    },
    get enabled() {
      return on;
    },
    // Mutes or unmutes a layer: "bed", "swarm", "room" or "life".
    setMuted(layer, muted) {
      mute[layer] = muted;
      if (layer === "bed" && bedGain) bedGain.gain.setTargetAtTime(muted ? 0 : bed, ctx.currentTime, 0.2);
    },
    // Plays one of the colony's sounds now, even with its layer muted (for the test panel).
    test(name, ...args) {
      testing = true;
      if (name === "click") {
        const e = lastCamera.matrixWorld.elements;
        clacks([e[12], e[13], e[14]], [-e[8], -e[9], -e[10]], [e[4], e[5], e[6]]);
      } else this[name](...args);
      testing = false;
    },
    // Playing (not waiting for a gesture).
    get running() {
      return !!ctx && ctx.state === "running";
    },
    setEnabled(v) {
      on = v;
      fadeTo(on ? volume : 0);
    },
    setPaused(v) {
      paused = v;
      if (!ctx) return;
      if (paused) ctx.suspend();
      else ctx.resume();
    },
  };
}
