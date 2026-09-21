# syntax=docker/dockerfile:1
# Saturday 全保真镜像：Node 22（运行时）+ Python + ASE/numpy（EMT 真物理档）。
# 零依赖 lj-js 仍是底档（若 python 不可用则自动回退），但本镜像已解锁 EMT。
# 刻意不含 MACE（torch 数 GB，留给需要者自行 pip；镜像保持可下载）。
#
# 无头一次性（默认走 CLI 参数）：
#   docker run --rm ghcr.io/toki0413/saturday --relax Cu
#   docker run --rm ghcr.io/toki0413/saturday --tools
#   docker run --rm ghcr.io/toki0413/saturday --call material.load '{"query":"TiO2:rutile"}'
# 作 stdio MCP server（无参即进服务协议）：docker run -i --rm ghcr.io/toki0413/saturday
# 作 streamable-http：docker run -p 3000:3000 --rm ghcr.io/toki0413/saturday --http
FROM node:22-bookworm

# Python + ASE（EMT）+ numpy；bookworm 有 PEP668，用 --break-system-packages 装到系统 python
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m pip install --no-cache-dir --break-system-packages ase numpy

WORKDIR /app

# 先装依赖（package.json/lock 不变则命中层缓存），再拷源码
COPY package.json package-lock.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY plugins ./plugins
COPY scripts ./scripts
RUN npm install --no-audit --no-fund

# 数据落盘目录（容器内可写）；启动横幅走 stderr，stdout 只放结果/协议
ENV NODE_ENV=production
RUN mkdir -p /app/saturday-data

ENTRYPOINT ["node", "packages/mcp-server/src/cli.mjs"]
# 无参 = stdio MCP server（客户端接入）；headless 用显式 --relax/--tools/--call
CMD []
