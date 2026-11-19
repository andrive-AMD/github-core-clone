# github-core-clone

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/andrive-AMD/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/andrive-AMD/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, standard library only:
git smart HTTP (protocol v2 ls-refs and fetch, v0 fallback, receive-pack with report-status,
shallow and incremental clones), the REST v3 surface (repositories, branches, git refs,
commits, contents, labels, issues and comments, pull requests with file diffs and squash or
merge merges), GraphQL v4 (viewer, repository, node, cursor-paginated connections, five
mutations, introspection), and an MCP endpoint whose six tools act on the same store as REST.
All state is in memory; the token's holder is mapped to the seeded scenario viewer at boot.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC:
https://make.fun/bounty/github-core-clone-01

## Run

The program is the entry side of the make.fun harness lifecycle: it binds an ephemeral port,
registers it with the env at `MAKEFUN_ENV_URL`, serves until the env reports done, and exits 0.

    node --experimental-strip-types main.ts

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — the entry <-> env lifecycle (register, /done polling); unchanged harness contract
- `app.ts` — HTTP routing and bearer auth
- `githttp.ts` — git smart HTTP: advertisements, ls-refs, fetch, receive-pack
- `git.ts` — the object model: SHA-1 objects, trees, commits, packfile read/write, pkt-lines
- `rest.ts` — the REST v3 surface
- `graphql.ts` — a small GraphQL parser/executor for the v4 surface
- `mcp.ts` — the MCP endpoint (JSON-RPC 2.0, server/discover, six tools)
- `store.ts` / `domain.ts` — in-memory state and the shapes every surface shares
- `scenario.ts` — the seeded scenario identities (a byte-exact port of the kit's generator)

## License

MIT
