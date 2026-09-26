/** esbuild bundles .md files as text (--loader:.md=text): the Jarvis brief is his prompt. */
declare module '*.md' {
  const text: string
  export default text
}
