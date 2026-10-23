const unavailable = () => {
	throw new Error("gzip is not available on the phone");
};
export const gzipSync = unavailable;
export const gunzipSync = unavailable;
export const constants = {};
export default { gzipSync, gunzipSync, constants };
