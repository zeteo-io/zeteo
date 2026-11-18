---
zeteo: minor
"@zeteo-io/sdk": minor
---

File Sources: a user with `zeteo.file_sources.write` uploads a CSV or Excel file, previews and corrects it, and gets an `upload` source they own, stored in Zeteo's Postgres and queried through a read-only reader role (`FILE_SOURCES_READER_URL`, off while unset). Owners grant, declare relations, describe, re-upload, retype, transfer and delete. `/v1/file-sources`, the `FILE_SOURCE_*` limits (bytes, rows, columns, quota, unconfirmed uploads and uploads in flight per user, xlsx workbooks read at once), start-up checks of the reader URL, the database version and Zeteo's `CREATE` privilege, "My data" in My Zeteo, file sources in the admin Sources list and a Limits dialog for admins. SDK: `fileSources` calls.
