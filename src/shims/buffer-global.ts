// pi-env uses the Buffer global; the WebView has none.
import { Buffer } from "buffer";

if (!("Buffer" in globalThis)) Object.assign(globalThis, { Buffer });
