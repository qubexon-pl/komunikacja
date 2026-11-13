// Build-time settings for the native apps; scripts/build-web.mjs rewrites this file from the environment.
// On the web the API is the same origin, so nothing here is needed. Client IDs are public, never secrets.
window.ONWARD_CONFIG = { apiBase: "", google: { webClientId: "", iosClientId: "" } };
