// 一次性脚本：生成 MCP 官方 Registry 的 server.json（mcpName 与 package.json 保持一致）
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8'))
if (pkg.mcpName !== 'io.github.toki0413/saturday-materials') {
  console.error('mcpName missing in packages/mcp-server/package.json')
  process.exit(1)
}

const serverJson = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'io.github.toki0413/saturday-materials',
  description: 'Saturday material-computing tool surface: structure loading/resolution, engine relaxation and single-point (EMT/LJ adaptive data plane), Gamma-point phonons, EOS/NEB analysis, candidate sampling (perturb/OU/affine flow), screening with convex-hull, derivation lineage. 30 tools over MCP.',
  repository: { url: 'https://github.com/toki0413/dsh-saturday', source: 'github' },
  version: pkg.version,
  packages: [
    {
      registryType: 'npm',
      identifier: '@toki0413/mcp-server',
      version: pkg.version,
      transport: { type: 'stdio' },
    },
  ],
}
writeFileSync('server.json', JSON.stringify(serverJson, null, 2) + '\n')
console.log('server.json written, version', serverJson.version)
