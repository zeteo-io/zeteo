---
core: major
---

Moves zeteo onto Tereo core 0.8.1, `@tereo-io/sdk` 0.5.2 and `@tereo-io/mcp` 0.1.1. A group grant's or group limits row's `principal_status` is now `active`, or `orphaned` for a group Tereo does not have, instead of always `unknown`.

What a deployer must do or know:

- **Tereo 0.8.1 or later.** The new `tereo-provisioning.json` requests the core role `group_resolver`, which Tereo 0.8.0 does not have: applied there, the whole provisioning set fails. Upgrade Tereo first, then apply the document.
- **What `group_resolver` reaches.** It grants `groups.read`, read-only access to every group, global and in every organization: zeteo's service account can list and search them, read each one's roles, its members' names, emails and active flag, and its SCIM skipped members' names and emails, and it can receive `auth.group.*` webhook events. Zeteo itself only reads a group by id, to report its status.
