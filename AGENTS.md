## Driftdriver Integration Protocol

When working on tasks in this project, follow this protocol:

### At Session Start
Run: `./.workgraph/handlers/session-start.sh --cli codex`

### When Claiming a Task
Run: `./.workgraph/handlers/task-claimed.sh --cli codex`

### Before Completing a Task
Run: `./.workgraph/handlers/task-completing.sh --cli codex`

### On Error
Run: `./.workgraph/handlers/agent-error.sh --cli codex`

### Drift Protocol
- Pre-check: `./.workgraph/drifts check --task <TASK_ID> --write-log`
- Post-check: `./.workgraph/drifts check --task <TASK_ID> --write-log --create-followups`
