---
zeteo: minor
"@zeteo-io/sdk": minor
---

File Sources: a user with `zeteo.file_sources.write` uploads a CSV or Excel file, previews and corrects it, and gets an `upload` source they own, stored in Zeteo's Postgres and queried through a read-only reader role (`FILE_SOURCES_READER_URL`, off while unset). Owners grant, declare relations, describe, re-upload, retype, transfer and delete. `/v1/file-sources`, the `FILE_SOURCE_*` limits, "My data" in My Zeteo and file sources in the admin Sources list. SDK: `fileSources` calls.
