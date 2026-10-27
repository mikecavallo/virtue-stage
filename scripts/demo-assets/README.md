# Demo-mode assets (offline segmentation + removal)

`generate.py` precomputes what the app's no-API-key demo mode needs for the five
sample photos in `app/public/samples/<id>/`:

| file | what it is |
| --- | --- |
| `inventory.json` | tappable objects: `box_2d` `[ymin, xmin, ymax, xmax]` and `mask` (one polygon of `[x, y]`), all integers normalized to 0-1000 like Gemini returns them, plus `children` and the `removal` patch rect |
| `remove/<object-id>.webp` | RGBA patch: inpainted pixels for removing the object **and its children**; alpha is the dilated + feathered removal mask. Draw it with `ctx.drawImage(patch, x, y)` over `original.jpg`. |
| `declutter.jpg` | optional: the photo with all movable furniture removed (only written when it looks believable) |

Patches and `declutter.jpg` carry the same ICC profile as `original.jpg` (the
living-room original is tagged Adobe RGB), so the browser color-manages both the
same way and seams stay invisible.

## Pipeline

1. **Detection:** Grounding DINO is run once per phrase in the photo's object list.
   The object list per photo is curated in `SPECS` in `generate.py`. Each entry has a
   phrase and a rough hint box; the DINO box with the best IoU against the hint is kept.
   The hint box is used as the SAM prompt only when DINO misses (IoU < 0.5).
2. **Segmentation:** SAM ViT-H takes the box prompt, plus optional include/exclude clicks.
   Masks are cleaned up: clipped to the box, small specks dropped and small holes filled.
   Overlaps are resolved with `subtract` where needed.
3. **Polygons:** the largest external contour is simplified with `cv2.approxPolyDP`
   to 20-120 points.
4. **Removal:** big-LaMa inpaints the object plus its children.
   - The removal mask is the object dilated by about 14 px (extra downward for contact
     shadows), then feathered with a Gaussian of about 6 px.
   - Other unrelated objects are masked out of the alpha, so removing one object never
     redraws a neighbour that the user already removed. Rugs are the exception
     (`surface`).
   - LaMa runs on a context crop around the hole, downscaled so the long side is at
     most 1024 px.
   - The result is saved as a WebP crop (quality 88, lossless alpha).
5. **Declutter:** every object, plus some background-only furniture (`extra`), is
   inpainted together.
6. **Verify:** each patch is composited exactly like canvas `drawImage` does
   (straight-alpha source-over at `(x, y)`) and compared with the pipeline's own
   result. The script also checks that the patch edges have zero alpha and that the
   ICC profile matches, then writes contact sheets to the work dir.

## Models

| step | checkpoint | license |
| --- | --- | --- |
| detection | [`IDEA-Research/grounding-dino-base`](https://huggingface.co/IDEA-Research/grounding-dino-base) @ `12bdfa31` | Apache-2.0 |
| segmentation | [`facebook/sam-vit-huge`](https://huggingface.co/facebook/sam-vit-huge) @ `87aecf0d` | Apache-2.0 |
| inpainting | big-LaMa ([advimman/lama](https://github.com/advimman/lama)), TorchScript export from IOPaint (`github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt`), fetched from the byte-identical HF mirror [`okaris/big-lama`](https://huggingface.co/okaris/big-lama) @ `a77c4957`, MD5 `e3aa4aaa15225a33ec84f9f4bc47e500` (checked at load) | Apache-2.0 |

## Run

Keep the venv, model caches and work files **outside the repo**:

```bash
WORK=/path/to/scratch/demo-assets-work      # anything outside the repo
python3 -m venv $WORK/venv
$WORK/venv/bin/pip install -r scripts/demo-assets/requirements.txt
export HF_HOME=$WORK/hf TORCH_HOME=$WORK/torch
$WORK/venv/bin/python scripts/demo-assets/generate.py --work $WORK/run
# subsets while iterating:
#   --samples bathroom --stages segment          (re-mask after editing SPECS)
#   --samples bathroom --stages remove,write,verify --only mirror-1
#   --stages candidates                          (DINO overlays for placing hint boxes)
```

On a 4-core CPU a full run takes about 25 minutes. Models download about 3.6 GB on
the first run. Contact sheets (`contact-<id>-masks.jpg`, `-removals.jpg`,
`-declutter.jpg`) land in `$WORK/run/`.
