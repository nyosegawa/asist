// pdfjs-dist's JavaScript decoder of JBIG2 and CCITT fax pictures, under the name pdf.js imports it by, noting that
// it was loaded.
;(globalThis.pdfDecodersLoaded ??= []).push('jbig2')
export { default } from '../../../node_modules/pdfjs-dist/wasm/jbig2_nowasm_fallback.js'
