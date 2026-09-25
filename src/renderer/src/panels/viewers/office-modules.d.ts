/**
 * Types for the distributions the Office viewers use.
 * - mammoth is taken from its browser bundle (mammoth.browser.js), because the node entry point does not
 *   accept {arrayBuffer}; the app, the demo and the tests therefore share one bundle.
 * - xlsx is taken from the mini build (250KB). It reads and writes xlsx and xlsm, and what it leaves out is
 *   ODS, XLSB and the older character encodings.
 */
declare module 'mammoth/mammoth.browser.js' {
  import mammoth = require('mammoth')
  export = mammoth
}

declare module 'xlsx/dist/xlsx.mini.min.js' {
  export * from 'xlsx'
}
