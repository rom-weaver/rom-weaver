// The base tag the build stamps on 404.html. The service worker and the Docker entrypoint re-root
// the page under a sub-path by finding it, so the build and the worker MUST agree on its spelling.
export const ROOT_BASE_TAG = '<base href="/" />';
