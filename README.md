# dash-it

Claude Code mod. `/dash-it` opens a live dashboard pane of background shells, monitors, subagents and schedules the session runs out of sight. `/dash-it close` closes it.

Widgets: timeline, background tasks, subagents, scheduled, activity. Add one by appending an entry to `WIDGETS` in `hooks/dashboard.tsx`.

## Install

```
/plugin install dash-it --marketplace mesolimbo/dash-it
```

Answer `y` to add the marketplace, then choose the user scope to load it in every session. The repo is private, so `gh auth login` (or an SSH key) must work on the machine. Update with `claude plugin update dash-it@dash-it`.

## Check

```
claude plugin validate .
claude plugin test .
```
