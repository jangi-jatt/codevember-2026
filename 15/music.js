// The soundtrack: one looping track, downloaded while the page loads. The AudioContext is created on load: it plays at
// once if the browser allows it, otherwise it starts on the first gesture.
import { fetchWithProgress } from "common";

export function createMusic({ url = new URL("./sound/tunnel.mp3", import.meta.url).href, onProgress, volume = 0.7 } = {}) {
  let ctx = null, gain = null, on = true, paused = false;
  const data = fetchWithProgress(url, onProgress).then((r) => r.arrayBuffer());
  data.catch(() => {});

  async function start() {
    ctx = new AudioContext();
    if (paused) ctx.suspend();
    gain = ctx.createGain();
    gain.gain.value = on ? volume : 0;
    gain.connect(ctx.destination);
    try {
      const buffer = await ctx.decodeAudioData((await data).slice(0));
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      source.start();
    } catch (e) {
      console.warn("music unavailable", e);
    }
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
    get enabled() {
      return on;
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
