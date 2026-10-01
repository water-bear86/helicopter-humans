#!/usr/bin/env node
// SPDX-License-Identifier: MIT
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Helicopter Humans needs Node.js 24 or newer. Install the current LTS from https://nodejs.org, then run the command again.')
  process.exitCode = 1
} else {
  const { run } = await import('../lib/cli.js')
  process.exitCode = await run()
}
