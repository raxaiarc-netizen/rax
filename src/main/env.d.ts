// Vite ?raw imports — file contents inlined as a string at build time.
declare module '*?raw' {
  const src: string
  export default src
}
