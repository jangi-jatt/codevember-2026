// Greasy fingerprints on the glass (after genuary-2026 day 6): real fingerprint scans (an atlas of 4 x 2) laid at
// random places, sizes and turns, faint and lightened together, into a tiling texture. hologram.js reads it as grease:
// rougher reflections, a slight relief, and a film that dims the hologram a little.
import { CanvasTexture, RepeatWrapping, LinearMipmapLinearFilter } from "three";

export async function loadFingerprints(onProgress) {
  const image = new Image();
  image.src = new URL("./fingerprints.jpg", import.meta.url).href;
  await image.decode();
  onProgress?.(1);
  return image;
}

const mulberry = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function createSmudges(renderer, image, { size = 1024 } = {}) {
  // Two textures: the next set is drawn into the hidden one a few prints a frame and uploaded before it goes on.
  const sides = [0, 1].map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const texture = new CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    return { ctx: canvas.getContext("2d"), texture };
  });
  let front = 0;
  let version = 0;
  const cw = image.width / 4, ch = image.height / 2;
  return {
    get texture() {
      return sides[front].texture;
    },
    // Draws a new set of prints from seed into the hidden texture, a slice a frame. Resolves true once done.
    async prepare(seed, count = 80) {
      const v = ++version;
      const { ctx: sctx, texture } = sides[1 - front];
      const r = mulberry(seed * 2246822519);
      sctx.globalCompositeOperation = "source-over";
      sctx.globalAlpha = 1;
      sctx.fillStyle = "#000";
      sctx.fillRect(0, 0, size, size);
      sctx.globalCompositeOperation = "lighten";
      for (let i = 0; i < count; i++) {
        if (i % 20 === 19) {
          await nextFrame();
          if (v !== version) return false;
        }
        const sx = Math.floor(r() * 4) * cw, sy = Math.floor(r() * 2) * ch;
        const x = r() * size, y = r() * size, rot = r() * Math.PI * 2;
        const s = ((0.2 + 0.3 * r()) * size) / 1024;
        sctx.globalAlpha = 0.04 + 0.06 * r();
        // Tiled: drawn at its neighbours' places too.
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            sctx.save();
            sctx.translate(x + ox * size, y + oy * size);
            sctx.rotate(rot);
            sctx.drawImage(image, sx, sy, cw, ch, -0.5 * cw * s, -0.5 * ch * s, cw * s, ch * s);
            sctx.restore();
          }
        }
      }
      await nextFrame();
      if (v !== version) return false;
      texture.needsUpdate = true;
      renderer.initTexture(texture);
      return true;
    },
    // Puts the prepared set on the glass; read texture after.
    show() {
      front = 1 - front;
    },
  };
}
