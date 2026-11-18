# Print head profiles

The JSON files in this directory are taken from **PancakeSlicer**
(https://github.com/zimengxiong/PancakeSlicer), licensed under the
GNU Affero General Public License v3.0 (AGPL-3.0).

They describe print heads as axis-aligned boxes in the nozzle-tip frame (mm)
and are used unchanged by `npg/collision.py` for the collision check.

## Derived presets

`bambu-a1-mini-no-duct*.json` are derived from the A1 mini profiles by
`tools/make_head_variants.py`: the part cooling fan and its duct are one
assembly on that printer (Bambu FAF006), so a machine with the fan removed
drops those boxes. Everything else (nozzle, heater sock, hotend fan, cover,
carriage, gantry) is unchanged. As derivatives of AGPL-3.0 files they are
AGPL-3.0 as well.
