# Phase 2 acceptance pass (desktop mode, merged `main`)

Run on 2026-11-10 against the merged branches, headless managed browser, real Mapillary data,
desktop mouse/keyboard only. Screenshots are in `docs/acceptance/`.

| # | Plan step | Result |
|---|---|---|
| 1 | Landing page, curated place | Seen (`01`). Typed search and the Enter XR button were not exercised. |
| 2 | Pick a place, enter street | Seen via the curated list, not via the map table (`02`). The real panorama took about 15 s to appear. |
| 3 | Hop to a neighbour, fade, no slide | **Not run** (arrows not clicked in the merged app). |
| 4 | TIME MACHINE lens | Seen (`03`): 2023 shown only inside the circle, label 2023, button turns to BACK TO NOW. |
| 5 | Wrist dial | Arrow keys change the year (`05`). XR pinch-and-twist not run on the merged app. Heading alignment judged by eye only (`04`: the Sephora sign is at the same bearing in both years). |
| 6 | Push through | Seen (`04`): the whole view becomes 2023 and the credit switches photographer. |
| 7 | Archive below earliest year | Seen (`05`): 2011, 2013 and 2017 photos with credits, also listed in the credit line. |
| 8 | Portal mode and step through | Seen (`06`): window, STEP IN, BACK TO ROOM; STEP IN returns to the street. Desktop has no passthrough, so the room is black. |
| 9 | Single-year spot, "no earlier imagery" | **Not run.** |
| 10 | Credit line in every state | Seen on landing, street, lens, archive and portal. |
| - | 20-hop memory check | **Not run** on the merged app (Track B ran it alone). |
| - | Performance pass (draw calls, 72 Hz) | **Not run.** |
| - | XR-session pass (table pick, controllers, hands) | **Not run** on the merged app. |

Environment notes: OpenFreeMap and Mapillary tile requests failed with `ERR_QUIC_PROTOCOL_ERROR`
in the managed browser, so the table map is only partly drawn there. The table plane looks
doubled in `01`; not investigated.
