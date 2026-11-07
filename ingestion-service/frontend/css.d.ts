// Side-effect stylesheet imports (e.g. `import 'leaflet/dist/leaflet.css'`)
// are consumed by esbuild, which emits the bundled CSS next to the JS
// bundle — TypeScript itself has no opinion on .css modules.
declare module '*.css';
