import { cliproxyapi } from "./cliproxyapi/adapter.ts";
import type { EndpointAdapter } from "./route.ts";

export const ADAPTERS: readonly EndpointAdapter[] = [cliproxyapi];
