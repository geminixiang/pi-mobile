/// <reference types="vite/client" />

declare const __BUILD__: string;
/** SHA-256 of each pi-env daemon the app carries, by "<os>-<arch>" (vite.config.ts). */
declare const __PI_ENV_DAEMONS__: Record<string, string>;
