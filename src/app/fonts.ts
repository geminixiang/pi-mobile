import commitMono400 from "@fontsource/commit-mono/files/commit-mono-latin-400-normal.woff2?url";
import commitMono700 from "@fontsource/commit-mono/files/commit-mono-latin-700-normal.woff2?url";
import instrumentSerifItalic from "@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2?url";
import { orLogged } from "../promise.ts";

const faces = [
	new FontFace("Commit Mono", `url(${commitMono400})`, { weight: "400", display: "swap" }),
	new FontFace("Commit Mono", `url(${commitMono700})`, { weight: "700", display: "swap" }),
	new FontFace("Instrument Serif", `url(${instrumentSerifItalic})`, { style: "italic", weight: "400", display: "swap" }),
];

for (const face of faces) {
	document.fonts.add(face);
	void orLogged(face.load(), "fonts.load_failed", undefined, { family: face.family });
}
