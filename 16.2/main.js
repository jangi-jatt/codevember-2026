// The 16.2 scene runs Day 16's spores with its own defaults: saffron palette, auto change off, cube spores, a single colony that morphs pyramid / ball / pyramid.
// They go in as url params before the day loads, so the day's code stays untouched.
const url = new URL(location.href);
for (const [k, v] of Object.entries({ palette: "saffron", auto: "false", shape: "cube", shapes: "morph", drag: "orbit", colonies: "1", breathe: "0", sporulation: "0", budding: "0", turbulence: "0.25", flow: "0.25", wildness: "0.2", cohesion: "0.1" })) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
history.replaceState(null, "", url);
await import("../16/main.js");
