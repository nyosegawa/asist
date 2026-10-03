// pdfjs-dist's JavaScript decoder of JPEG 2000 pictures, under the name pdf.js imports it by, noting that it was
// loaded.
;(globalThis.pdfDecodersLoaded ??= []).push('openjpeg')
export { default } from '../../../node_modules/pdfjs-dist/wasm/openjpeg_nowasm_fallback.js'
