// Stand-in for the 'cloudflare:workers' module when a test bundles Worker code to run pure functions in
// Node (no bindings: anything that touches env or D1 is never called there).
export const env = {};
export const waitUntil = () => {};
