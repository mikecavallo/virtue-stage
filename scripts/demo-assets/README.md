# Demo-mode assets (offline segmentation + removal)

`generate.py` precomputes what the app's no-API-key demo mode needs for the sample
photos in `app/public/samples/<id>/`:

| file | what it is |
| --- | --- |
| `inventory.json` | tappable objects: `box_2d` `[ymin, xmin, ymax, xmax]` and `mask` (one polygon of `[x, y]`), all integers normalized to 0-1000 like Gemini returns them, plus `children` and the `removal` patch rect |
| `remove/<object-id>.webp` | RGBA patch for removing the object **and all of its descendants**. Draw it with `ctx.drawImage(patch, x, y)` over `original.jpg`. |
| `declutter.jpg` | optional: the photo with every movable thing removed. Only written when it looks believable. |

Patches and `declutter.jpg` carry the same ICC profile as `original.jpg` (the
living-room original is tagged Adobe RGB). The browser therefore color-manages both
the same way, and the seams stay invisible.

## Contract for the app

- **Patches compose in any order.** Draw each removed object's patch onto the
  original, in the order the user removed them.
- **Never draw a child's patch after its parent's.** Removing a parent removes its
  whole subtree, so mark its descendants removed. `children` lists direct children
  only, and the tree can be several levels deep (rug → bed → nightstand → lamp).
- **Hit-testing should prefer the smallest polygon that contains the tap.** Parent
  polygons (a bed) contain their children's polygons (pillows).

## Pipeline

1. **Detection:** Grounding DINO runs once per phrase in the photo's curated object
   list (`SPECS` in `generate.py`). Each entry has a phrase and a rough hint box; the
   DINO box with the best IoU against the hint is kept. The hint box is used as the
   SAM prompt only when DINO misses (IoU < 0.5) or the spec says `box="hint"`.
2. **Segmentation:** SAM ViT-H takes the box prompt, plus optional include/exclude
   clicks and extra `parts` that are merged into the mask.
   - Masks are clipped to the box, small specks are dropped and small holes filled.
   - `attach` adds unlisted bits that are removed with an object (books under a vase,
     a white pillow stacked behind a patterned one).
   - `extra` marks background furniture that is not tappable.
3. **Polygons:** the largest external contour is simplified with `cv2.approxPolyDP`
   to 20-120 points.
4. **Removal with shared clean plates.** This is what makes the patches compose.
   - **Clusters.** Removable units that touch each other form a cluster. "Touch"
     means one unit's mask reaches into the other's feathered removal alpha.
   - **Shared plate.** Each cluster is inpainted once into a clean plate, and every
     member's patch is cut from that same plate with its own alpha. The fill behind a
     side table is therefore wall and floor, never the neighbouring armchair's fabric,
     and overlapping patches agree pixel for pixel.
   - **Sequential fill.** Plates are filled one unit at a time with big-LaMa. Each
     pass uses a small hole: the unit's own support, plus a ~48 px band of the
     still-present neighbours so their texture is not continued into it. Small pieces
     (lamps, pillows, vases) are then re-filled once more with clean context. One
     LaMa pass over a whole cluster turns large holes into grey fog.
   - **Children.** A child (a pillow) is filled from a plate where its ancestors stay.
     LaMa regenerates the sofa fabric on the parent's extent, and outside the parent
     the child's plate is the parent's plate.
   - **Alpha.** Each patch's alpha is the object's mask, dilated (12 px for furniture,
     plus 10 px downward for contact shadows; 6 px for wall decor and soft goods),
     then feathered with a Gaussian (σ 3-5 px). It is zero on every other visible
     object except within 5 px of the removed object's own edge.
   - **Extras** stay in all tappable plates as protected context.
   - **Output.** Each patch is a WebP crop (quality 88, lossless alpha).
5. **Occlusion.** If tappable object A stands in front of tappable object B, any
   composable removal of A alone has to show what was hidden behind A. So either:
   - **A is made B's child.** Examples: the nightstand in front of the bed, the
     pepper mills in front of the pot, the bed standing on the rug. Removing A alone
     lets LaMa continue B, and removing B takes A along.
   - **A stays as `extra` background.** Examples: the side table and vase in front of
     the accent chair, the sideboard behind the fig, the snake plant in front of the
     wall hanging.

   Objects LaMa cannot remove believably at all also stay as background. Examples: the
   leather sofa in front of a busy kitchen, and four overlapping dining chairs, which
   became one `dining-set-1`.

   The one remaining exception is armchair-1 in front of the living-room side table.
   Removing the armchair alone shows the table's hidden part as background, so the
   table looks cut off.
6. **Declutter:** every object plus every extra is removed, built the same way.
7. **Verify:**
   - Each patch is composited exactly like canvas `drawImage` (straight-alpha
     source-over at `(x, y)`) and compared with the pipeline's own result.
   - The ICC profile and the patch rects are checked.
   - All objects are removed in list order, in reverse, and children-first, and the
     results must agree.
   - Every overlapping pair of unrelated objects is removed in both orders, and the
     two results must agree.
   - Contact sheets are written to the work dir.

## Models

| step | checkpoint | license |
| --- | --- | --- |
| detection | [`IDEA-Research/grounding-dino-base`](https://huggingface.co/IDEA-Research/grounding-dino-base) @ `12bdfa31` | Apache-2.0 |
| segmentation | [`facebook/sam-vit-huge`](https://huggingface.co/facebook/sam-vit-huge) @ `87aecf0d` | Apache-2.0 |
| inpainting | big-LaMa ([advimman/lama](https://github.com/advimman/lama)), TorchScript export from IOPaint (`github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt`), fetched from the byte-identical HF mirror [`okaris/big-lama`](https://huggingface.co/okaris/big-lama) @ `a77c4957` (MD5 `e3aa4aaa15225a33ec84f9f4bc47e500`, checked at load) | Apache-2.0 |

`syscv-community/sam-hq-vit-huge` was tried and returned unusable masks with
transformers 5.21.

## Run

Keep the venv, model caches and work files **outside the repo**:

```bash
WORK=/path/to/scratch/demo-assets-work      # anything outside the repo
python3 -m venv $WORK/venv
$WORK/venv/bin/pip install -r scripts/demo-assets/requirements.txt
export HF_HOME=$WORK/hf TORCH_HOME=$WORK/torch
$WORK/venv/bin/python scripts/demo-assets/generate.py --work $WORK/run
# subsets while iterating:
#   --samples bathroom --stages segment                 (re-mask after editing SPECS)
#   --samples bathroom --stages remove,write,verify
#   --stages candidates                                 (DINO overlays for placing hint boxes)
```

On a 4-core CPU with no GPU a full run takes about 20 minutes. Models download about
3.6 GB on the first run. Detections and SAM embeddings are cached in the work dir, so
later partial runs are much faster.

Contact sheets land in `$WORK/run/`:
- `contact-<id>-masks.jpg`: polygons;
- `contact-<id>-removals.jpg`: before/after for each patch;
- `contact-<id>-combos.jpg`: everything removed, plus overlapping pairs in both orders;
- `contact-<id>-declutter.jpg`.

`declutter.jpg` is published only for samples whose spec sets
`declutter=dict(publish=True)`, after reviewing the candidate.
