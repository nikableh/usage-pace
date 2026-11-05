# usage-pace

A Claude Code mod that shows whether your plan usage is running ahead of or behind a steady burn until each limit resets.

A "Pace" chip sits in the composer footer beside the model picker. Press it to open a panel above the prompt with one row per limit: the 5-hour window, the weekly window, and the per-model weekly window when the Claude desktop app reports one. Each bar shows what you have used, a tick at where a steady burn would be right now, stripes for the room left before the tick (or the stretch past it when you are over pace), the time until the reset as a countdown, and a verdict such as "41% under pace". The panel refreshes every minute. `/usage-pace` toggles it too.

The chip's label is a plugin option (Pace, Usage, Plan usage, Limits), set in the config menu.

## Install

At the prompt of a terminal session:

```
/plugin install usage-pace --marketplace nikableh/usage-pace
```

From a shell:

```
claude plugin install usage-pace --marketplace nikableh/usage-pace
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nikableh/usage-pace`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope. The user scope loads the mod in every session, the desktop app's included.

## Notes

- Per-model limits come from the desktop app's own usage tool. Terminal sessions show the 5-hour and weekly rows only.
- The engine lays type declarations into `.claude-plugin/types/` when it loads the mod; `tsc -p .` type-checks against them. `claude plugin test .` runs the tests.
