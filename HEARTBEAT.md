# HEARTBEAT.md - Periodic Checks

## Memory Maintenance Tasks

Run these checks during heartbeats (2-4 times per day):

### Daily
- [ ] Check for new daily memory files to review
- [ ] Update MEMORY.md with significant learnings from past 24h
- [ ] Archive processed daily notes if needed

### Weekly (every Monday)
- [ ] Summarize week's daily notes into weekly summary
- [ ] Review MEMORY.md for outdated information
- [ ] Compress old memories per compression-engine rules
- [ ] Update project status sections

### Monthly
- [ ] Roll up weekly summaries into monthly review
- [ ] Full MEMORY.md review and pruning
- [ ] Archive cold memories (rarely accessed)

---

## Other Periodic Checks (Rotate Through)

- **Emails** — Any urgent unread messages?
- **Calendar** — Upcoming events in next 24-48h?
- **GitHub** — New PRs, issues, or mentions?
- **Project Status** — Any stale branches or pending work?

---

## State Tracking

Track last checks in `memory/heartbeat-state.json`:

```json
{
  "lastChecks": {
    "email": null,
    "calendar": null,
    "github": null,
    "memoryMaintenance": null
  }
}
```

---

## When to Notify A

- Important email arrived
- Calendar event in <2h
- PR requires review
- Something interesting discovered
- Been >8h since last contact

## When to Stay Silent

- Late night (23:00-08:00) unless urgent
- Nothing new since last check
- Just checked <30 minutes ago
- Casual banter in group chats (respond with HEARTBEAT_OK)
