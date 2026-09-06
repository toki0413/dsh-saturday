// 一次性脚本：构造 MCPB manifest.json（含 ${__dirname} 字面量，不经 shell 以避免插值吞没）
import { writeFileSync } from 'node:fs'

const stage = process.argv[2]
if (!stage) { console.error('usage: node make-manifest.mjs <staging-dir>'); process.exit(1) }
const DOLLAR = String.fromCharCode(36) // '$'
const manifest = {
  dxt_version: '0.1',
  name: 'saturday-materials',
  display_name: 'Saturday Materials',
  version: '0.3.2',
  description: 'Saturday material-computing tool surface: structure loading/resolution, engine relaxation and single-point (EMT/LJ adaptive data plane), Gamma-point phonons, EOS/NEB analysis, candidate sampling (perturb/OU/affine flow), screening with convex-hull, derivation lineage. 30 tools over MCP.',
  author: { name: 'toki0413' },
  keywords: ['materials-science', 'computational-chemistry', 'mcp'],
  server: {
    type: 'node',
    entry_point: 'node_modules/@toki0413/mcp-server/src/cli.mjs',
    mcp_config: {
      command: 'node',
      args: [`${DOLLAR}{__dirname}/node_modules/@toki0413/mcp-server/src/cli.mjs`],
    },
  },
}
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2))
console.log('args[0]:', manifest.server.mcp_config.args[0])
