// The soundtrack: one looping track, downloaded and decoded while the page loads, played from play(). The AudioContext
// is created on load: it runs at once if the browser allows it, otherwise it starts on the first gesture.
import { fetchWithProgress } from "common";

export function createMusic({ url = new URL("./sound/tunnel.mp3", import.meta.url).href, onProgress, volume = 0.7 } = {}) {
  let ctx = null, gain = null, on = true, paused = false, startAt = 0, duration = 0, buffer = null, wanted = false;
  const data = fetchWithProgress(url, onProgress).then((r) => r.arrayBuffer());
  data.catch(() => {});

  async function start() {
    ctx = new AudioContext();
    if (paused) ctx.suspend();
    gain = ctx.createGain();
    gain.gain.value = on ? volume : 0;
    gain.connect(ctx.destination);
    try {
      buffer = await ctx.decodeAudioData((await data).slice(0));
      if (wanted) begin();
    } catch (e) {
      console.warn("music unavailable", e);
    }
  }
  // Starts the track (once decoded and asked for with play()).
  function begin() {
    if (!buffer || duration) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
    startAt = ctx.currentTime;
    duration = buffer.duration;
  }
  start();
  const resume = () => {
    if (ctx && ctx.state === "suspended" && !paused) ctx.resume();
  };
  for (const e of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(e, resume, { capture: true });

  // Fades the level instead of cutting it.
  function fadeTo(v) {
    if (!gain) return;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(v, t, 0.15);
  }

  return {
    loaded: data,
    // Begins playing (the page calls it once everything is ready).
    play() {
      wanted = true;
      begin();
    },
    get enabled() {
      return on;
    },
    // Seconds into the track as it is heard (looping), or -1 while it isn't playing. currentTime runs ahead of the
    // speakers by the output latency (more over Bluetooth), less the frame the picture takes to reach the screen.
    get time() {
      if (!ctx || !duration || ctx.state !== "running") return -1;
      const heard = ctx.currentTime - startAt - Math.max(0, (ctx.outputLatency || ctx.baseLatency || 0) - 1 / 60);
      return heard < 0 ? 0 : heard % duration;
    },
    // Audible: playing and switched on.
    get audible() {
      return on && !!duration && !!ctx && ctx.state === "running";
    },
    // Playing (not waiting for a gesture, nor off).
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
