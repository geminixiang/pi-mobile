// just-bash's gzip, gunzip, and zcat use node:zlib, which the WebView lacks; in the app they fail with this message.
const unavailable = () => {
	throw new Error("gzip is not available on the phone");
};
export const gzipSync = unavailable;
export const gunzipSync = unavailable;
export const constants = {};
export default { gzipSync, gunzipSync, constants };
