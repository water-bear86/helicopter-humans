import { defineConfig } from 'vite'

// Builds the local operator tools (relay prototype, sandbox preflight) into .tools-build/ for Node.
// Never part of the site build or a deployment.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    outDir: '.tools-build',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: {
      input: { relay: 'src/relay/cli.ts', 'sandbox-preflight': 'src/sandbox/cli.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
})
