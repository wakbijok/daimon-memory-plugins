<div align="center">

# daimon-memory-plugins

**The community plugin marketplace for daimon-memory. Claude Code + Codex clients, decoupled from the server.**

![status](https://img.shields.io/badge/status-experimental-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## What it is

The client side of [daimon-memory](https://github.com/wakbijok/daimon-memory) -- plugins that auto-recall relevant + recent memory into every prompt and expose `remember` / `recall` / `read` tools, backed by a daimon-memory server you run.

This repo is client-only and independent of the server. The plugins talk to whatever `DAIMON_ENDPOINT` you point them at -- local or remote -- so you never clone the server to use the clients.

Full documentation: **[wakbijok.uk/man/daimon-memory](https://wakbijok.uk/man/daimon-memory/)**

---

## Quick start

### Claude Code

**1. Add the marketplace and install**

```text
/plugin marketplace add wakbijok/daimon-memory-plugins
/plugin install daimon-memory@daimon-memory
```

**2. Set the connection config**

The `/plugin` UI can't write the endpoint, so run the helper once:

```bash
git clone https://github.com/wakbijok/daimon-memory-plugins
./daimon-memory-plugins/claude-code/install.sh
```

Pass `--endpoint URL --tenant UUID [--api-key TOKEN] --yes` to skip the prompts. It writes `DAIMON_*` into `~/.claude/settings.json`. Restart Claude Code -- the first prompt should show a `<daimon-memory>` recall block.

### Codex

```bash
git clone https://github.com/wakbijok/daimon-memory-plugins
./daimon-memory-plugins/codex/install.sh
```

> No API key? Omit `--api-key`. The server is open when `DAIMON_API_KEY` is unset -- fine on localhost, not on a shared network.

---

## Configuration

Read at runtime (the installer sets these):

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `DAIMON_ENDPOINT` | yes | -- | daimon-memory base URL (local or remote) |
| `DAIMON_TENANT` | no | dev tenant | memory space; must match your other tools |
| `DAIMON_NAMESPACE` | no | `agent/lessons` | default capture namespace |
| `DAIMON_API_KEY` | no | -- | bearer token, if the server sets one |

---

## Develop

```bash
node --test tests/*.test.mjs
```

`claude-code/` and `codex/` are sibling plugin trees; the shared libs (`daimon.mjs`, `nudge-lib.mjs`, `state-paths.mjs`) are kept byte-identical across both, and the tests check that.

> GitHub is primary here for community reach (`/plugin marketplace add owner/repo`); GitLab is a mirror. The daimon-memory server stays GitLab-primary.

## License

[MIT](LICENSE).
