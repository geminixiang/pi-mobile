// Browser stand-in for node:path. The sandbox is Linux, so win32 paths are never used; posix serves both names.
import path from "path-browserify";

export const posix = path;
export const win32 = path;
export const { dirname, join } = path;
export default path;
