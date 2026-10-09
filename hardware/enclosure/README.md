# Calf Dyno snap enclosure — first-fit prototype

Created in Fusion for the soldered D1 mini + ADS1220 + load-cell assembly. Hardware dimensions were not supplied: this is an adjustable, generous-clearance prototype, not a verified board-specific fit.

## Files

- `calf_dyno_enclosure.f3d`: editable Fusion design with two components, named features and user parameters; lid in assembled position.
- `base.stl` and `lid.stl`: millimetres, each placed flat at Z=0 in the intended print orientation. Import as separate objects in Bambu Studio.
- `calf_dyno_enclosure.step`: assembled solid CAD interchange file.
- `enclosure_preview.png`: initial overview of the base and upside-down lid; the PLA revision lengthens the tabs by 2 mm and lowers the matching windows by 2 mm.
- `create_enclosure.py`: Fusion Python script recreating the parametric design in a new document.
- `base_raw.stl`, `lid_raw.stl`: intermediate Fusion exports, in assembly coordinates. Use `base.stl` and `lid.stl` for printing.
- `prepare_prints.py`: converts the default-size raw meshes to print orientation and validates their topology. Its orientation offsets match this delivered 90 × 65 × 34 mm design; update offsets for resized exports, or orient resized parts in the slicer.

## Dimensions and construction

| Item | Default |
|---|---:|
| Assembled exterior | 90 × 65 × 34 mm |
| Nominal clear cavity | 86 × 61 × 30 mm |
| Wall / floor / lid plate | 2 / 2 / 2 mm |
| USB-C plug opening | 16 mm wide × 10 mm high |
| USB opening bottom | 4 mm above exterior bottom (2 mm above interior floor) |
| Cable notch | 7 mm wide × 7 mm deep, rounded bottom |
| Lid fit clearance | 0.30 mm per side |
| Snap tabs | Four, 14 mm long × 8 mm wide × 1.2 mm thick |
| Snap-hook projection | 0.55 mm from stem; nominal wall engagement 0.25 mm |
| Snap root fillet | 0.8 mm |

The cavity size is the bounding clear envelope: lid clips and corner guides occupy small regions near the walls, and a low cable-tie bridge occupies space near the cable end. Leave wiring clear of those features.

The USB opening is centered on one short wall. The load-cell cable drops into a U-shaped notch on the opposite short wall; the lid closes its top. Nothing needs to be threaded over the already-soldered cable. The notch is not a compression gland or seal.

The floor is flat so the boards can be secured with insulating foam tape or removable adhesive mounts after positioning the D1 mini's USB-C socket at the opening. There are no assumed mounting-hole patterns or board-specific standoffs. Check the socket height and USB plug insertion depth with the actual board and plug before permanently mounting anything.

A small internal bridge accepts a narrow zip tie for cable strain relief. Route the cable with a gentle bend and secure its jacket, avoiding tension on the solder joints. This enclosure is not a load-bearing part of the dynamometer.

## First print on a Bambu Lab P1S

Suggested starting settings, assuming the standard 0.4 mm nozzle:

- 0.20 mm layer height, 4 wall loops, 5 top/bottom layers, 15–20% infill.
- Use the matching filament preset in Bambu Studio.
- Base: floor on plate, open cavity up.
- Lid: broad outside face on plate, clips pointing up; the provided STL is already flipped.
- Start with supports off. Inspect bridging in the slice preview: the USB opening spans 16 mm, snap windows about 8.6 mm, and tie tunnel 4 mm. Adjust bridge settings or add targeted support if the chosen material/profile needs it; avoid support inside the snap clearances.
- Use PLA as requested. The PLA revision uses 14 mm flexible tabs and 0.25 mm nominal hook engagement to reduce the deflection needed to latch. Test the empty enclosure first; clip life has not been physically tested.

Fit and snap durability have not been physically tested. Test the lid on the empty box first. Press progressively near each tab rather than forcing the center. Release tabs by pushing them inward through the side windows with a small blunt tool while lifting the adjacent lid edge.

## Adjust in Fusion

Open Modify → Change Parameters. Main parameters are `inside_length`, `inside_width`, `inside_height`, `usb_width`, `usb_height`, `usb_bottom`, `usb_y`, `cable_width`, `cable_depth` and `fit_clearance`. Exterior dimensions are derived automatically. Sizes are in mm.

For a tight snap, increasing `fit_clearance` from 0.30 to 0.35 mm reduces engagement; keep it below `snap_projection` or the hooks will cease to latch. Increasing clearance also loosens the corner guides. Change by small amounts and test. The cable-seat radius is linked to cable width; retain enough notch depth for that radius. Arbitrarily large parameter changes may require feature edits.

Hide the lid component to inspect the cavity. After editing, export both components again and orient the lid outside-face down in Bambu Studio. Do not scale the entire STL to resize the enclosure: that changes wall thickness, port size and snap clearances together.

## Checks performed

PLA revision: changed snap length 12→14 mm and hook projection 0.65→0.55 mm. Recomputed with no warnings, rechecked zero assembled interference, and regenerated/validated both print meshes. The lid print height is now 16 mm. The dimensional resize test below was performed on the initial revision.

- Two solid bodies, one per component; all 64 timeline items healthy.
- No assembled solid interference (coincident contact faces excluded).
- Successfully resized interior length 86→96 mm, width 61→66 mm, height 30→34 mm, USB width 16→18 mm and cable width 7→8 mm, then restored defaults; no feature warnings.
- Both print meshes are closed, manifold, connected, positive-volume meshes at Z=0. Full measurements are in `mesh_validation.json`.
- Inspected the Fusion preview. Physical electronics fit, cable clearance and snap fatigue remain first-print checks.
