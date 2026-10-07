# dash-it

Claude Code mod. `/dash-it` opens a live dashboard pane of background shells, monitors, subagents and schedules the session runs out of sight. `/dash-it close` closes it.

Widgets: timeline, background tasks, subagents, scheduled, activity. Add one by appending an entry to `WIDGETS` in `hooks/dashboard.tsx`.

## Install

```
/plugin install dash-it --marketplace <path-to-this-folder>
```

Choose the user scope to load it in every session.

## Check

```
claude plugin validate .
claude plugin test .
```
