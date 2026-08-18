// Everything the app requests is relative to the path it is mounted at, so the
// same build works at "/" and behind an nginx sub-path like "/monit/".
// Vite bakes BASE_URL in at build time from the `base` option.
export const API_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
