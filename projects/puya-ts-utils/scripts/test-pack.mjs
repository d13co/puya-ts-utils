/**
 * Packs this package and uses it the way a consumer would, from a scratch pnpm
 * workspace: the package's own tests import src/ by relative path, so they never
 * see the installed layout.
 *
 * - compiles a contract that imports the .algo.ts entries with puya-ts
 * - runs a unit test on it through algorand-typescript-testing, with the vitest
 *   config the README gives
 * - loads the dist entries with plain Node, as CommonJS and as ESM
 * - type-checks them with moduleResolution nodenext
 * - checks dist never imports algorand-typescript, an optional peer off chain
 *
 * Needs the network or a warm pnpm store. Pass --keep to leave the workspace behind.
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const dev = pkg.devDependencies
const root = mkdtempSync(join(tmpdir(), 'puya-ts-utils-pack-'))
const consumer = join(root, 'consumer')
const run = (cmd, cwd = consumer) => {
  console.log(`$ ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}
const write = (file, text) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

try {
  run(`npm pack --pack-destination ${root}`, process.cwd())
  const tarball = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`

  write(join(root, 'package.json'), JSON.stringify({ private: true }))
  // The single-copy override the README documents: in a workspace it goes here.
  write(
    join(root, 'pnpm-workspace.yaml'),
    `packages:\n  - consumer\noverrides:\n  '@algorandfoundation/algorand-typescript': '${pkg.pnpm.overrides['@algorandfoundation/algorand-typescript']}'\n`,
  )
  write(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      private: true,
      dependencies: {
        [pkg.name]: `file:../${tarball}`,
        ...Object.fromEntries(
          [
            '@algorandfoundation/algokit-utils',
            '@algorandfoundation/algorand-typescript',
            '@algorandfoundation/algorand-typescript-testing',
            '@algorandfoundation/puya-ts',
            '@rollup/plugin-typescript',
            '@tsconfig/node22',
            '@types/node',
            'algosdk',
            'tslib',
            'typescript',
            'vitest',
          ].map((name) => [name, dev[name]]),
        ),
      },
    }),
  )

  // The README's vitest config, verbatim.
  const readme = readFileSync('README.md', 'utf8')
  const config = /<!-- vitest-config -->\s*```ts\n([\s\S]*?)```/.exec(readme)?.[1]
  if (!config) throw new Error('README has no <!-- vitest-config --> block')
  write(join(consumer, 'vitest.config.mts'), config)
  write(
    join(consumer, 'vitest.setup.ts'),
    `import { addEqualityTesters } from '@algorandfoundation/algorand-typescript-testing'
import { beforeAll, expect } from 'vitest'

beforeAll(() => addEqualityTesters({ expect }))
`,
  )
  write(
    join(consumer, 'contracts/probe.algo.ts'),
    `import { createUnfundedAccount } from '${pkg.name}/createAccount'
import { getTxnCounter } from '${pkg.name}/getTxnCounter'
import { parseRsaDnskey, verifyRsaSha256 } from '${pkg.name}/rsa'
import { MbrManager } from '${pkg.name}/mbrManager'
import { base32Encode } from '${pkg.name}/base32'
import { Account, Bytes, bytes, Global, uint64 } from '@algorandfoundation/algorand-typescript'

export class Probe extends MbrManager {
  public account(): Account {
    return createUnfundedAccount()
  }
  public counter(): uint64 {
    return getTxnCounter(Global.zeroAddress)
  }
  public verify(digest: bytes, signature: bytes, key: bytes): boolean {
    const [exponent, modulus] = parseRsaDnskey(key)
    return verifyRsaSha256(digest, signature, modulus, exponent, Bytes())
  }
  public encode(data: bytes): string {
    return base32Encode(data)
  }
}
`,
  )
  write(
    join(consumer, 'contracts/probe.algo.spec.ts'),
    `import { Bytes } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { expect, test } from 'vitest'
import { Probe } from './probe.algo'

test('runs the installed package through the test transformer', () => {
  const ctx = new TestExecutionContext()
  const probe = ctx.contract.create(Probe)
  expect(probe.encode(Bytes.fromHex('666f6f626172'))).toBe('MZXW6YTBOI')
  expect(probe.logCredits([ctx.defaultSender])).toBeUndefined()
})
`,
  )
  write(
    join(consumer, 'client.mts'),
    `import { CREDIT_BOX_MBR_MICROALGOS, creditBoxName, MbrErrorMessages } from '${pkg.name}/mbrManagerSdk'
import { rsaMontgomeryHint } from '${pkg.name}/rsaHint'
import { errorTransformer } from '${pkg.name}/rsaSdk'

const n: number = CREDIT_BOX_MBR_MICROALGOS
const name: Uint8Array = creditBoxName(new Uint8Array(32))
const hint: Uint8Array = rsaMontgomeryHint(new Uint8Array([0xc5, 0x01]))
console.log(n, name.length, hint.length, typeof errorTransformer, Object.keys(MbrErrorMessages).length)
`,
  )
  // The AlgoKit template's test tsconfig, which the vitest config points at.
  write(
    join(consumer, 'tsconfig.test.json'),
    JSON.stringify({
      extends: '@tsconfig/node22/tsconfig.json',
      compilerOptions: { noEmit: true, target: 'ES2023', module: 'ESNext', lib: ['ES2023'], moduleResolution: 'Bundler', esModuleInterop: true },
      include: ['**/*.ts', '**/*.mts'],
      exclude: ['node_modules'],
    }),
  )
  write(
    join(consumer, 'tsconfig.client.json'),
    JSON.stringify({
      compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', strict: true, noEmit: true, types: ['node'] },
      files: ['client.mts'],
    }),
  )

  run('pnpm install --prefer-offline --config.confirmModulesPurge=false', root)
  run('npx puya-ts contracts/probe.algo.ts --out-dir out')
  run('npx vitest run')
  run('npx tsc -p tsconfig.client.json')
  const dist = join(consumer, 'node_modules', pkg.name, 'dist')
  for (const file of readdirSync(dist, { recursive: true })) {
    if (/\.[cm]?js$|\.d\.ts$/.test(file) && readFileSync(join(dist, file), 'utf8').includes('@algorandfoundation/algorand-typescript'))
      throw new Error(`dist/${file} imports @algorandfoundation/algorand-typescript, which is optional off chain`)
  }
  for (const entry of ['mbrManagerSdk', 'rsaHint', 'rsaSdk']) {
    run(`node -e "require('${pkg.name}/${entry}')"`)
    run(`node --input-type=module -e "await import('${pkg.name}/${entry}')"`)
  }
  console.log(`\nThe packed package works from ${consumer}`)
} finally {
  if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true })
}
