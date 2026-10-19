// Latin subsets only, bundled with the app (no network). CJK text falls back to the system's Noto Sans TC / PingFang.
import plexSans from "@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2?url";
import jetbrainsMono from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import instrumentSerifItalic from "@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2?url";

const faces = [
	new FontFace("Plex Sans", `url(${plexSans})`, { weight: "100 700", display: "swap" }),
	new FontFace("JetBrains Mono", `url(${jetbrainsMono})`, { weight: "100 800", display: "swap" }),
	new FontFace("Instrument Serif", `url(${instrumentSerifItalic})`, { style: "italic", weight: "400", display: "swap" }),
];

for (const face of faces) {
	document.fonts.add(face);
	void face.load().catch(() => undefined);
}
