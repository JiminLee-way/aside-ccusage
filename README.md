# aside-ccusage

Makes [Aside Browser](https://aside.com) token usage show up in [ccusage](https://github.com/ccusage/ccusage).

Aside writes one transcript per task to `~/.aside/u/<account>/sessions/<date>_<id>/messages.jsonl`.
Assistant records look like:

```json
{"role":"assistant","provider":"claude-code","model":"claude-opus-5-5",
 "usage":{"input":4,"output":275,"cacheRead":19360,"cacheWrite":3044,"totalTokens":22683,
          "cost":{"total":0.03374,"totalFromProvider":false},"reasoning":89},
 "responseId":"msg_011...","timestamp":1793407013014}
```

ccusage does not read that layout, but its pi adapter accepts *named stores* that use the same
token vocabulary (`input / output / cacheRead / cacheWrite / totalTokens / cost.total`). This tool
mirrors each Aside session into a pi-format JSONL file and registers the store as agent `aside`.

## Install / use

```sh
# one-time: mirror transcripts and register the store in ~/.claude/ccusage.json
node aside-ccusage.mjs setup        # or: npm i -g . && aside-ccusage setup

# afterwards either of these works
npx ccusage@latest daily            # plain ccusage, reads the mirrored store (run `sync` first for fresh data)
aside-ccusage daily --last 7        # sync new transcripts, then run ccusage with the same args
```

Result: `ccusage daily|weekly|monthly|session` list an `aside` agent, models are labelled
`[aside] claude-opus-5-5`, `[aside] gpt-6-astra`, ... and cost is Aside's own per-call estimate
(ccusage `auto` mode keeps a stored cost; use `--mode calculate` to re-price from tokens when the
model is in the pricing table).

## Options

| flag | default | meaning |
|---|---|---|
| `--src DIR` | `~/.aside` (`$ASIDE_HOME`) | Aside home |
| `--store DIR` | `~/.aside-ccusage/sessions` | where the pi-format mirror lives |
| `--name NAME` | `aside` | agent name in reports |
| `--provider P` | all | only `claude-code`, `openai-codex`, or `aside` records |
| `--format claude` | | write Claude Code JSONL instead and use `CLAUDE_CONFIG_DIR="$HOME/.claude,<store>"` |
| `--full` | | rewrite every session instead of only changed ones |

`sync` is incremental (compares mtimes), so running it before every report is cheap.

## Field mapping

| Aside | pi store | ccusage column |
|---|---|---|
| `usage.input` | `message.usage.input` | Input |
| `usage.output` (includes `reasoning`) | `message.usage.output` | Output |
| `usage.cacheRead` | `message.usage.cacheRead` | Cache Read |
| `usage.cacheWrite` | `message.usage.cacheWrite` | Cache Create |
| `usage.cost.total` | `message.usage.cost.total` | Cost (USD) |
| `model` | `message.model` | Models (`[aside] <model>`) |
| `responseId` | `id` | (dedupe) |
| session folder `<date>_<id>` | file name `<date>_<id>.jsonl` | Session |

Verified against ccusage 20.0.48.
