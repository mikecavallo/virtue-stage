#!/usr/bin/env python3
"""Precompute VirtueStage demo-mode assets (segmentation + object removal).

For every sample photo in app/public/samples/<id>/original.jpg this writes:

  inventory.json      objects with Gemini-style box_2d / mask polygons (0-1000)
  remove/<obj>.webp   RGBA patches: inpainted pixels, alpha = feathered removal mask
  declutter.jpg       (optional) the room with all movable furniture removed

Pipeline: Grounding DINO (open-vocabulary boxes) -> SAM ViT-H (box-prompted
masks) -> mask cleanup -> big-LaMa inpainting into shared "clean plates", so
patches compose in any removal order (see Removal / build_plate and README.md
for details, model IDs and licenses).

The object list for each photo is curated in SPECS below: each object has a
Grounding DINO phrase plus a hand-placed hint box that selects which detection
to keep (and is used as the SAM prompt only if DINO misses the object).

Usage:
  python generate.py --work /path/to/scratch [--samples living-room open-plan]
                     [--stages detect,segment,remove,declutter,write,verify]
                     [--stages candidates]   # DINO overlays for placing hint boxes
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageCms

REPO = Path(__file__).resolve().parents[2]
SAMPLES_DIR = REPO / "app" / "public" / "samples"

GDINO_ID, GDINO_REV = "IDEA-Research/grounding-dino-base", "12bdfa3120f3e7ec7b434d90674b3396eccf88eb"
SAM_ID, SAM_REV = "facebook/sam-vit-huge", "87aecf0df4ce6b30cd7de76e87673c49644bdf67"
# big-lama TorchScript export (advimman/lama "big-lama" weights, traced by IOPaint/lama-cleaner).
# Original URL github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt; this is a
# byte-identical Hugging Face mirror (MD5 matches IOPaint's LAMA_MODEL_MD5).
LAMA_REPO, LAMA_REV, LAMA_FILE = "okaris/big-lama", "a77c4957376bb29a47a3339283477d4b31748b68", "big-lama.pt"
LAMA_MD5 = "e3aa4aaa15225a33ec84f9f4bc47e500"

SOURCE = "Precomputed offline with Grounding DINO + SAM (segmentation) and LaMa (removal)"
ROOM_TYPES = {"living-room", "bedroom", "kitchen", "dining-room", "bathroom", "office"}


# ----------------------------------------------------------------------------
# Per-photo object specs. Coordinates are pixels in original.jpg.
#   id        "<label-slug>-<n>"; the label is derived from it ("throw-pillow-1" -> "throw pillow")
#   prompt    Grounding DINO phrase used to find it
#   hint      rough (x0, y0, x1, y1) box that picks the matching detection
#   children  ids of listed objects removed together with it: things resting on it, and
#             things standing in front of it (an occluder is its occludee's child, so removing
#             the occluder alone continues the object behind it and every order composes)
#   attach    unlisted bits removed together with it: dicts with prompt/hint (+ SAM options)
#   points    extra SAM clicks [(x, y, 1=include | 0=exclude), ...]
#   mask      which of SAM's 3 multimask outputs to use ("best" = highest predicted IoU)
#   box       "det" (default: DINO box, hint as fallback) or "hint" (force the hint box)
#   parts     extra prompts whose masks are merged into this object's own mask (e.g. headboard)
#   subtract  ids whose masks are removed from this one (overlap cleanup)
#   extent    "hull": a child's removal continues this parent over its convex hull (rugs)
#   halo/bottom/sigma  removal alpha tuning in px at 1200 px width (see Removal._feather)
# "extra" entries are not tappable: they stay as protected background in every patch and are
# removed only in declutter.jpg. declutter=dict(publish=True) writes declutter.jpg (after
# review of the candidate); declutter=dict() only renders a candidate in the work dir.
# ----------------------------------------------------------------------------
def O(oid, prompt, hint, **kw):
    return dict(id=oid, prompt=prompt, hint=hint, **kw)


def X(prompt, hint, **kw):
    return dict(prompt=prompt, hint=hint, **kw)


SPECS: dict = {
    # Bright open-plan living room with a dining area on the right.
    "living-room": dict(
        title="Living room", roomType="living-room",
        objects=[
            O("armchair-1", "armchair", (0, 433, 423, 757), children=["throw-pillow-1"]),
            O("throw-pillow-1", "pillow", (181, 458, 310, 576)),
            O("armchair-2", "armchair", (442, 410, 649, 625), children=["throw-pillow-2"]),
            O("throw-pillow-2", "pillow", (510, 429, 594, 508)),
            O("side-table-1", "side table", (298, 457, 455, 610), children=["table-lamp-1"]),
            O("table-lamp-1", "table lamp", (360, 323, 443, 474)),
            # The four chairs and the round table are one tappable set. Chairs hide most of the
            # table and each other, so a single chair cannot be removed believably on its own.
            O("dining-set-1", "dining chair", (1024, 404, 1200, 709), points=[(1125, 610, 0)],
              parts=[X("dining chair", (901, 383, 1036, 597)),
                     X("dining chair", (938, 375, 1028, 487)),
                     X("dining chair", (1108, 376, 1200, 429)),
                     X("dining table", (972, 418, 1036, 570), box="hint"),
                     X("table leg", (1108, 585, 1145, 632), box="hint")]),
            O("wall-art-1", "framed picture", (775, 278, 838, 320)),
            O("wall-art-2", "framed picture", (1040, 295, 1147, 343)),
        ],
        extra=[  # background furniture, removed only in declutter.jpg
            X("potted plant", (900, 285, 968, 392)),
            X("sofa", (989, 362, 1146, 423)),
            X("armchair", (719, 370, 794, 453)),
            X("potted plant", (720, 395, 770, 460)),
            X("coffee table", (850, 406, 913, 470)),
            X("rug", (796, 434, 919, 489)),
            X("table lamp", (954, 340, 986, 377)),
            X("table lamp", (1128, 343, 1188, 380)),
            X("vase", (752, 296, 776, 330), box="hint"),
        ],
        declutter=dict(),
    ),
    # Open-plan living room (leather sofa).
    # The sofa itself is not removable: LaMa cannot invent the kitchen behind it (every setting
    # tried gives a grey slab), so it stays as protected background, and so do the knit
    # blanket over its arm and the left pillow pair (grey smears). The sideboard is background too, so removing the
    # fig in front of it continues the sideboard instead of biting a hole in it.
    "open-plan": dict(
        title="Open-plan living room", roomType="living-room",
        objects=[
            # the patterned pillow goes together with the white pillow stacked behind it; with
            # the white pillow left as context LaMa copies its pattern into the hole
            O("throw-pillow-1", "pillow", (616, 460, 705, 543),
              attach=[X("pillow", (595, 462, 628, 542), box="hint")]),
            O("armchair-1", "armchair", (951, 466, 1200, 712), children=["throw-pillow-2"],
              attach=[X("pillow", (1155, 466, 1200, 584), box="hint")]),
            O("throw-pillow-2", "pillow", (1029, 466, 1173, 584)),
            O("side-table-1", "side table", (745, 514, 806, 632)),
            O("potted-plant-1", "potted plant", (830, 428, 945, 590)),
            O("mirror-1", "round mirror", (800, 315, 878, 412)),
            O("wall-art-1", "wall hanging", (681, 198, 730, 452)),
        ],
        extra=[
            X("sofa", (193, 463, 776, 745)),
            X("blanket", (183, 505, 320, 650)),
            # the left pillow pair: LaMa fills it with a grey-brown block whatever the settings
            X("pillow", (270, 478, 415, 588), points=[(395, 500, 0)],
              parts=[X("pillow", (272, 466, 412, 556), box="hint",
                       points=[(300, 480, 1), (395, 505, 1), (316, 476, 1), (290, 474, 1)])]),
            # snake plant behind the sofa (0.2 % of the image) hides the bottom of the wall hanging
            X("potted plant", (700, 440, 755, 495)),
            X("sideboard", (757, 468, 850, 585)),
            X("vase", (774, 438, 800, 472), box="hint"),
            X("picture frame", (794, 443, 820, 472), box="hint"),
            X("potted plant", (0, 400, 265, 790), parts=[X("basket", (0, 695, 35, 790), box="hint")]),
            X("side table", (50, 543, 192, 570), box="hint"),
            X("lamp", (48, 432, 140, 492), box="hint"),
            X("planter", (138, 460, 185, 525), box="hint"),
            X("pot", (66, 510, 120, 560), box="hint"),
            X("plates", (115, 533, 160, 556), box="hint"),
            X("chair", (1, 638, 287, 799)),
            X("dining table", (175, 466, 320, 500), box="hint"),
            X("hat", (1022, 312, 1053, 357), box="hint"),
            X("potted plant", (1165, 448, 1200, 476), box="hint"),
        ],
    ),
    # NOTE: two people cooking dominate this photo; only cookware/decor is tappable.
    "kitchen": dict(
        title="Kitchen", roomType="kitchen",
        objects=[
            O("dutch-oven-1", "dutch oven", (30, 168, 145, 232), box="hint"),
            O("dutch-oven-2", "dutch oven", (33, 490, 158, 560), box="hint"),
            # the pepper mills stand in front of the pot: removing one alone continues the pot
            # behind it; removing the pot takes them along (see "Occlusion" in README)
            O("stock-pot-1", "pot", (505, 578, 710, 750), children=["pepper-mill-1", "pepper-mill-2"]),
            O("pepper-mill-1", "pepper mill", (575, 705, 635, 800)),
            O("pepper-mill-2", "pepper mill", (650, 710, 712, 800)),
            O("saucepan-1", "saucepan", (252, 618, 412, 732)),
            O("bell-peppers-1", "bell pepper", (108, 703, 210, 797)),
            O("dining-table-1", "dining table", (1050, 550, 1200, 800)),
        ],
        extra=[  # too small to tap (< 0.3 %) and overlapping their neighbours: kept as background
            X("avocado", (60, 735, 118, 795)),
            X("casserole dish", (700, 232, 778, 268)),
            X("potted plant", (652, 210, 705, 262)),
        ],
    ),
    "bedroom": dict(
        title="Bedroom", roomType="bedroom",
        objects=[
            # table-lamp-2 stands on a nightstand hidden behind the bed, and nightstand-1 stands in
            # front of the bed's left side: both go with the bed (see "Occlusion" in README)
            O("bed-1", "bed", (231, 394, 874, 798),
              children=["throw-pillow-1", "throw-pillow-2", "table-lamp-2", "nightstand-1"],
              parts=[X("headboard", (233, 393, 505, 535)),
                     X("pillow", (283, 397, 401, 442), box="hint"),
                     X("pillow", (283, 423, 455, 522)),
                     X("pillow", (416, 397, 503, 430), box="hint"),
                     X("pillow", (536, 415, 572, 488), box="hint")]),
            O("throw-pillow-1", "pillow", (451, 418, 550, 485), points=[(558, 455, 0)]),
            O("throw-pillow-2", "pillow", (392, 439, 542, 504)),
            O("nightstand-1", "nightstand", (77, 535, 280, 737), children=["table-lamp-1"],
              attach=[X("ball", (215, 508, 253, 540), box="hint"), X("book", (195, 530, 275, 555))]),
            O("table-lamp-1", "table lamp", (116, 393, 236, 552)),
            O("table-lamp-2", "table lamp", (516, 395, 574, 483)),
            O("wall-art-1", "framed picture", (290, 239, 446, 377), halo=12),
            O("accent-chair-1", "chair", (875, 469, 1149, 705), children=["throw-pillow-3"]),
            O("throw-pillow-3", "pillow", (973, 466, 1089, 565)),
            # the bed, chair and side table stand on the rug, so they go with it (keeps patches composable)
            O("area-rug-1", "rug", (198, 608, 1176, 799), children=["bed-1", "accent-chair-1"],
              extent="hull"),
        ],
        # The side table stands in front of the chair; removing it (or the vase) alone would
        # have to reconstruct the chair back behind it, which LaMa fills with wall. They stay as
        # background, so removing the chair leaves the table standing in front.
        extra=[
            X("side table", (1011, 530, 1199, 767), mask=2),
            X("vase of flowers", (1052, 505, 1135, 562)),
            X("books", (1049, 548, 1148, 578)),
        ],
        declutter=dict(),
    ),
    "bathroom": dict(
        title="Bathroom", roomType="bathroom",
        objects=[
            O("potted-plant-1", "potted plant", (0, 1155, 325, 1680),
              parts=[X("flower pot", (84, 1522, 240, 1682), box="hint")]),
            O("step-stool-1", "step stool", (392, 1341, 642, 1705)),
            O("mirror-1", "mirror", (200, 668, 432, 976)),
            O("potted-plant-2", "plant in basket", (488, 930, 640, 1118)),
            O("hanging-plant-1", "hanging plant", (600, 925, 715, 1262),
              parts=[X("hook", (628, 924, 668, 1004), box="hint")]),
            O("hanging-plant-2", "hanging plant", (995, 275, 1200, 750)),
            O("planter-1", "bowl", (698, 1058, 752, 1112)),
            O("waste-bin-1", "trash can", (772, 1438, 865, 1500)),
            O("jar-1", "jar", (920, 1400, 985, 1525), box="hint",
              parts=[X("toothbrush", (955, 1330, 988, 1425), box="hint")]),
        ],
        declutter=dict(publish=True),
    ),
}


def label_of(oid: str) -> str:
    return re.sub(r"-\d+$", "", oid).replace("-", " ")


# ----------------------------------------------------------------------------
# Utilities
# ----------------------------------------------------------------------------
def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def load_original(sid: str):
    im = Image.open(SAMPLES_DIR / sid / "original.jpg")
    icc = im.info.get("icc_profile")
    return np.array(im.convert("RGB")), icc


def icc_name(icc: bytes | None) -> str:
    if not icc:
        return "none (sRGB assumed)"
    return ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip()


def box_iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def disk(r: int):
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def dilate(m: np.ndarray, r: float) -> np.ndarray:
    if r <= 0:
        return m.copy()
    return cv2.dilate(m.astype(np.uint8), disk(r)) > 0


def shift_down(m: np.ndarray, dy: int) -> np.ndarray:
    """Union of m with copies shifted down by 1..dy px (extends a mask downward)."""
    if dy <= 0:
        return m.copy()
    k = np.zeros((2 * dy + 1, 1), np.uint8)
    k[: dy + 1] = 1  # anchor at centre: a pixel is set if any pixel up to dy above it is set
    return cv2.dilate(m.astype(np.uint8), k) > 0


def nodes_for(spec):
    """Flatten listed objects + attachments into nodes with parent pointers."""
    nodes = {}
    for o in spec["objects"]:
        nodes[o["id"]] = dict(o, kind="object", parent=None)
    for o in spec["objects"]:
        for c in o.get("children", []):
            assert c in nodes, f"unknown child {c}"
            assert nodes[c]["parent"] is None, f"{c} has two parents"
            nodes[c]["parent"] = o["id"]
        for i, a in enumerate(o.get("attach", [])):
            nid = f"{o['id']}~{i}"
            nodes[nid] = dict(a, id=nid, kind="attach", parent=o["id"])
    for i, e in enumerate(spec.get("extra", [])):
        nid = f"extra~{e.get('name', i)}"
        nodes[nid] = dict(e, id=nid, kind="extra", parent=None)
    return nodes


def descendants(nodes, nid):
    out = [nid]
    for k, n in nodes.items():
        if n["parent"] == nid:
            out += descendants(nodes, k)
    return out


def ancestors(nodes, nid):
    out = []
    p = nodes[nid]["parent"]
    while p:
        out.append(p)
        p = nodes[p]["parent"]
    return out


# ----------------------------------------------------------------------------
# Stage 1: Grounding DINO detection (cached per sample + phrase)
# ----------------------------------------------------------------------------
def stage_detect(sid, spec, work: Path):
    import torch
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    cache_f = work / sid / "dets.json"
    cache = json.loads(cache_f.read_text()) if cache_f.exists() else {}
    nodes = nodes_for(spec)
    want = list(nodes.values()) + [pt for n in nodes.values() for pt in n.get("parts", [])]
    prompts = sorted({n["prompt"] for n in want if n.get("box") != "hint"})
    todo = [p for p in prompts if p not in cache]
    if todo:
        proc = AutoProcessor.from_pretrained(GDINO_ID, revision=GDINO_REV)
        model = AutoModelForZeroShotObjectDetection.from_pretrained(GDINO_ID, revision=GDINO_REV).eval()
        img = Image.fromarray(load_original(sid)[0])
        for p in todo:
            t = time.time()
            inp = proc(images=img, text=p.lower().strip(".") + ".", return_tensors="pt")
            with torch.no_grad():
                out = model(**inp)
            res = proc.post_process_grounded_object_detection(
                out, inp.input_ids, threshold=0.12, text_threshold=0.12, target_sizes=[img.size[::-1]])[0]
            dets = [dict(box=[round(v, 1) for v in b], score=round(s, 4))
                    for b, s in zip(res["boxes"].tolist(), res["scores"].tolist())]
            dets.sort(key=lambda d: -d["score"])
            cache[p] = dets
            log(f"[{sid}] dino '{p}': {len(dets)} boxes ({time.time() - t:.1f}s)")
        (work / sid).mkdir(parents=True, exist_ok=True)
        cache_f.write_text(json.dumps(cache, indent=1))
    return cache


def draw_candidates(sid, dets, work: Path):
    """Debug: one overlay per phrase with every DINO box (for placing hints)."""
    rgb, _ = load_original(sid)
    d = work / sid / "candidates"
    d.mkdir(parents=True, exist_ok=True)
    for p, ds in dets.items():
        v = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        for i, de in enumerate(ds[:25]):
            x0, y0, x1, y1 = map(int, de["box"])
            col = (0, 0, 255) if i < 5 else (0, 200, 255)
            cv2.rectangle(v, (x0, y0), (x1, y1), col, 2)
            cv2.putText(v, f"{i}:{de['score']:.2f}", (x0 + 3, y0 + 16), 0, 0.5, (0, 255, 0), 2)
        cv2.imwrite(str(d / f"{re.sub(r'[^a-z0-9]+', '_', p)}.jpg"), v)


def pick_box(node, dets):
    hint = node["hint"]
    if node.get("box") == "hint":
        return list(hint), "hint", 0.0
    best, best_iou = None, 0.0
    for p in [node["prompt"]] + node.get("alt", []):
        for de in dets.get(p, []):
            iou = box_iou(hint, de["box"])
            if iou > best_iou:
                best, best_iou = de, iou
    if best is not None and best_iou >= node.get("min_iou", 0.5):
        return list(best["box"]), "dino", best_iou
    return list(hint), "hint-fallback", best_iou


# ----------------------------------------------------------------------------
# Stage 2: SAM masks
# ----------------------------------------------------------------------------
def clean_mask(m: np.ndarray, box, margin=10, min_frac=0.02, hole_frac=0.02, keep_largest=False):
    H, W = m.shape
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    clip = np.zeros_like(m)
    clip[max(0, y0 - margin):min(H, y1 + margin), max(0, x0 - margin):min(W, x1 + margin)] = True
    m = m & clip
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    if n <= 1:
        return m
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = np.zeros(n, bool)
    if keep_largest:
        keep[1 + int(np.argmax(areas))] = True
    else:
        keep[1:] = (areas >= max(40, min_frac * areas.max()))
    m = keep[lab]
    # fill small holes (enclosed background specks), keep big gaps such as between chair legs
    inv = (~m).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, 4)
    total = m.sum()
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        touches = x == 0 or y == 0 or x + w == W or y + h == H
        if not touches and a < max(150, hole_frac * total):
            m[lab == i] = True
    return m


def stage_segment(sid, spec, dets, work: Path):
    import torch
    from transformers import SamModel, SamProcessor

    rgb, _ = load_original(sid)
    nodes = nodes_for(spec)
    mdir = work / sid / "masks"
    mdir.mkdir(parents=True, exist_ok=True)
    proc = SamProcessor.from_pretrained(SAM_ID, revision=SAM_REV)
    model = SamModel.from_pretrained(SAM_ID, revision=SAM_REV).eval()
    img = Image.fromarray(rgb)
    emb_f = work / sid / "sam_emb.pt"
    base = proc(images=img, return_tensors="pt")
    if emb_f.exists():
        emb = torch.load(emb_f)
    else:
        t = time.time()
        with torch.no_grad():
            emb = model.get_image_embeddings(base["pixel_values"])
        torch.save(emb, emb_f)
        log(f"[{sid}] SAM image embedding {time.time() - t:.1f}s")
    def sam_one(n):
        box, src, iou = pick_box(n, dets)
        pts = n.get("points", [])
        kw = dict(input_boxes=[[box]])
        if pts:
            kw["input_points"] = [[[[p[0], p[1]] for p in pts]]]
            kw["input_labels"] = [[[p[2] for p in pts]]]
        inp = proc(images=img, return_tensors="pt", **kw)
        inp.pop("pixel_values", None)
        with torch.no_grad():
            out = model(image_embeddings=emb, multimask_output=True, **inp)
        masks = proc.post_process_masks(out.pred_masks, base["original_sizes"], base["reshaped_input_sizes"])[0][0]
        scores = out.iou_scores[0, 0].tolist()
        sel = n.get("mask", "best")
        k = int(np.argmax(scores)) if sel == "best" else int(sel)
        m = masks[k].numpy().astype(bool)
        m = clean_mask(m, box, margin=n.get("clip_margin", 10), keep_largest=n.get("keep_largest", False))
        return m, dict(box=[round(v, 1) for v in box], box_src=src, det_iou=round(iou, 3),
                       sam_scores=[round(v, 3) for v in scores], sam_pick=k)

    meta = {}
    raw = {}
    for nid, n in nodes.items():
        m, meta[nid] = sam_one(n)
        for part in n.get("parts", []):  # extra prompts merged into this object's own mask
            pm, pmeta = sam_one(part)
            m |= pm
            meta[nid].setdefault("parts", []).append(pmeta)
        raw[nid] = m
    for nid, n in nodes.items():  # overlap cleanup
        m = raw[nid].copy()
        for other in n.get("subtract", []):
            m &= ~raw[other]
        cv2.imwrite(str(mdir / f"{nid}.png"), m.astype(np.uint8) * 255)
        meta[nid]["area_frac"] = round(float(m.mean()), 5)
        log(f"[{sid}] {nid:24s} {meta[nid]['box_src']:13s} iou={meta[nid]['det_iou']:.2f} "
            f"sam={meta[nid]['sam_scores']} pick={meta[nid]['sam_pick']} area={meta[nid]['area_frac'] * 100:.2f}%")
    (work / sid / "seg_meta.json").write_text(json.dumps(meta, indent=1))
    return meta


def load_masks(sid, spec, work: Path):
    out = {}
    for nid in nodes_for(spec):
        out[nid] = cv2.imread(str(work / sid / "masks" / f"{nid}.png"), cv2.IMREAD_GRAYSCALE) > 127
    return out


# ----------------------------------------------------------------------------
# Polygon / box in Gemini's normalized format
# ----------------------------------------------------------------------------
def mask_to_polygon(m: np.ndarray, lo=20, hi=120):
    H, W = m.shape
    # close small gaps so thin parts (legs) join the body before taking the largest contour
    mm = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, disk(4))
    cs, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    peri = cv2.arcLength(c, True)
    eps = 0.0015 * peri
    approx = cv2.approxPolyDP(c, eps, True)
    for _ in range(40):
        if len(approx) > hi:
            eps *= 1.25
        elif len(approx) < lo and eps > 0.3:
            eps *= 0.7
        else:
            break
        approx = cv2.approxPolyDP(c, eps, True)
    pts = [tuple(p) for p in approx[:, 0, :].astype(float)]
    while len(pts) < lo:  # simple shapes (framed art): split the longest edges
        i = max(range(len(pts)), key=lambda i: np.hypot(*np.subtract(pts[i], pts[i - 1])))
        mid = tuple((np.array(pts[i]) + np.array(pts[i - 1])) / 2)
        pts.insert(i, mid)
    poly = [[int(round(x / (W - 1) * 1000)), int(round(y / (H - 1) * 1000))] for x, y in pts]
    dedup = [p for i, p in enumerate(poly) if p != poly[i - 1]]
    return dedup


def mask_to_box2d(m: np.ndarray):
    H, W = m.shape
    ys, xs = np.nonzero(m)
    return [int(np.floor(ys.min() / H * 1000)), int(np.floor(xs.min() / W * 1000)),
            int(np.ceil((ys.max() + 1) / H * 1000)), int(np.ceil((xs.max() + 1) / W * 1000))]


# ----------------------------------------------------------------------------
# Stage 3: LaMa removal
# ----------------------------------------------------------------------------
class Lama:
    def __init__(self):
        import torch
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(LAMA_REPO, LAMA_FILE, revision=LAMA_REV)
        md5 = hashlib.md5(Path(path).read_bytes()).hexdigest()
        if md5 != LAMA_MD5:
            raise SystemExit(f"big-lama.pt checksum mismatch: {md5} != {LAMA_MD5}")
        self.torch = torch
        self.model = torch.jit.load(path, map_location="cpu").eval()

    def __call__(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        torch = self.torch
        h, w = mask.shape
        ph, pw = (-h) % 8, (-w) % 8
        img = np.pad(rgb, ((0, ph), (0, pw), (0, 0)), mode="symmetric")
        msk = np.pad(mask.astype(np.uint8), ((0, ph), (0, pw)), mode="symmetric")
        it = torch.from_numpy(img.transpose(2, 0, 1)[None].astype(np.float32) / 255.0)
        mt = torch.from_numpy(msk[None, None].astype(np.float32))
        with torch.no_grad():
            out = self.model(it, mt)[0].permute(1, 2, 0).numpy()
        return np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)[:h, :w]


def inpaint_region(lama, rgb, hole, ctx=0.6, min_ctx=64, max_side=1024):
    """Inpaint `hole` (bool HxW) using a context crop; returns full-size RGB (original outside hole)."""
    H, W = hole.shape
    ys, xs = np.nonzero(hole)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    pad = max(min_ctx, int(ctx * max(x1 - x0, y1 - y0)))
    cx0, cy0, cx1, cy1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
    crop, cm = rgb[cy0:cy1, cx0:cx1], hole[cy0:cy1, cx0:cx1]
    ch, cw = cm.shape
    s = min(1.0, max_side / max(ch, cw))
    if s < 1.0:
        sw, sh = int(round(cw * s)), int(round(ch * s))
        small = cv2.resize(crop, (sw, sh), interpolation=cv2.INTER_AREA)
        smask = cv2.resize(cm.astype(np.float32), (sw, sh), interpolation=cv2.INTER_AREA) > 0.01
        res = lama(small, smask)
        res = cv2.resize(res, (cw, ch), interpolation=cv2.INTER_LANCZOS4)
    else:
        res = lama(crop, cm)
    out = rgb.copy()
    region = out[cy0:cy1, cx0:cx1]
    region[cm] = res[cm]
    return out


def encode_patch(rgb_full, alpha, icc, path: Path):
    """Crop to alpha>0 bbox, save RGBA WebP. Returns (x, y, w, h)."""
    a8 = np.clip(alpha * 255 + 0.5, 0, 255).astype(np.uint8)
    ys, xs = np.nonzero(a8)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    rgba = np.dstack([rgb_full[y0:y1, x0:x1], a8[y0:y1, x0:x1]])
    path.parent.mkdir(parents=True, exist_ok=True)
    kw = dict(quality=88, alpha_quality=100, method=6)
    if icc:
        kw["icc_profile"] = icc
    Image.fromarray(rgba, "RGBA").save(path, "WEBP", **kw)
    return x0, y0, x1 - x0, y1 - y0


# (halo, bottom, sigma) in px at 1200 px width. Floor-standing furniture needs a wide halo for
# contact shadows; wall decor and soft goods need a tight one, otherwise LaMa has to redraw the
# edge of whatever is behind them (the top of an armchair back, a mantel panel).
_WALL, _SOFT = (6, 0, 3), (6, 4, 3)
FEATHER_DEFAULTS = {"": (12, 10, 5), "wall art": _WALL, "mirror": _WALL, "round mirror": _WALL,
                    "wall hanging": _WALL, "throw pillow": _SOFT, "throw blanket": _SOFT,
                    "table lamp": _SOFT, "vase": _SOFT}


class Removal:
    """Removal geometry for one photo.

    Patches must compose in any order (users remove several objects in sequence and the app
    draws each chosen patch over the original). So patches are NOT inpainted one by one.
    Removable units that touch each other (see touches()) form a cluster. The whole cluster is
    inpainted into one shared "clean plate" (build_plate), and every member's patch is cut from
    that plate with only its own alpha. Fill behind a side table is therefore wall/floor, never
    a continuation of the armchair next to it, and two adjacent patches show the same pixels
    wherever they overlap.

    Hierarchy: a child (pillow) is filled from a plate in which its ancestors (the sofa) stay,
    so the pillow's hole gets sofa fabric. Its siblings and other touching units are removed.
    Its parent's patch covers it again with the parent-level plate. "extra" nodes (background
    furniture the user cannot tap) always stay in tappable plates and are protected from every
    patch. They are removed only in declutter.jpg.
    """

    def __init__(self, spec, masks, shape):
        self.nodes = nodes_for(spec)
        self.masks = masks
        self.shape = shape
        H, W = shape
        self.s = W / 1200.0
        self.fam = {k: set(descendants(self.nodes, k)) for k in self.nodes}
        self.anc = {k: set(ancestors(self.nodes, k)) for k in self.nodes}
        self.core = {}
        self.alpha0 = {}
        for k, n in self.nodes.items():
            core = np.zeros(shape, bool)
            for d in self.fam[k]:
                core |= masks[d]
            self.core[k] = core
            self.alpha0[k] = self._feather(core, n)
        # "touching" uses the hard (fully removed) zone, not the soft feather tail: two plates
        # meeting only in feather tails differ by a few levels there, which is invisible, while
        # merging them into one cluster makes a much bigger (blurrier) hole
        self.reach = {k: dilate(self._hard(self.core[k], n), 2) for k, n in self.nodes.items()}
        self.own_sup = {k: self._feather(masks[k], n) > 0 for k, n in self.nodes.items()}
        self._touch = {}
        self._inner = {}
        extras = np.zeros(shape, bool)
        for k, n in self.nodes.items():
            if n["kind"] == "extra":
                extras |= masks[k]
        self.extras = extras

    def _params(self, n):
        s = self.s
        d = FEATHER_DEFAULTS.get(label_of(n["id"]) if n["kind"] == "object" else "", FEATHER_DEFAULTS[""])
        return (n.get("halo", d[0]) * s,      # px swallowed around the object (edge halos)
                n.get("bottom", d[1]) * s,    # extra px below it (contact shadows)
                n.get("sigma", d[2]) * s)     # Gaussian feather

    def _hard(self, core, n):
        halo, bottom, _ = self._params(n)
        return shift_down(dilate(core, halo), int(round(bottom)))

    def _feather(self, core, n):
        _, _, sigma = self._params(n)
        hard = self._hard(core, n)
        grown = dilate(hard, 1.5 * sigma)
        a = cv2.GaussianBlur(grown.astype(np.float32), (0, 0), sigma)
        a[hard] = 1.0
        a[a < 1.5 / 255] = 0.0
        return a

    def inner(self, nid):
        """Object pixels plus a 5 px rim that always belongs to the removal, even where a
        neighbour's mask overlaps it (SAM masks share anti-aliased fringes; left as context,
        a dark fringe makes LaMa grow the removed object back)."""
        if nid not in self._inner:
            self._inner[nid] = dilate(self.core[nid], 5 * self.s)
        return self._inner[nid]

    def touches(self, a, b):
        """Same plate needed: one's mask is in the other's hard zone, or both feathers are
        substantial (> 0.15) at some pixel. Plates that differ only where one alpha is < 0.15
        change the composite by at most 0.15 * (plate difference): invisible."""
        key = tuple(sorted((a, b)))
        if key not in self._touch:
            self._touch[key] = bool((self.core[a] & self.reach[b]).any() or (self.core[b] & self.reach[a]).any()
                                    or ((self.alpha0[a] > 0.15) & (self.alpha0[b] > 0.15)).any())
        return self._touch[key]

    def cluster(self, nid, with_extras=False):
        """Units (family roots) inpainted together with nid, given that nid's ancestors stay."""
        A = self.anc[nid]
        roots = [k for k, n in self.nodes.items()
                 if k not in A and (n["parent"] is None or n["parent"] in A)
                 and (with_extras or n["kind"] != "extra")]
        comp, todo = {nid}, [nid]
        while todo:
            a = todo.pop()
            for b in roots:
                if b not in comp and self.touches(a, b):
                    comp.add(b)
                    todo.append(b)
        return sorted(comp)

    def alpha(self, nid):
        """Patch alpha: own feathered family mask, zero on every other visible object."""
        keep = self.fam[nid] | self.anc[nid]
        excl = np.zeros(self.shape, bool)
        for k in self.nodes:
            if k not in keep:
                excl |= self.masks[k]
        excl = dilate(excl, 2) & ~self.inner(nid)
        a = self.alpha0[nid].copy()
        a[excl] = 0.0
        return a

    def extent(self, nid):
        """Where the parent is visible once a child is gone: its own mask (closed, holes filled)
        plus its family's pixels inside its convex hull (a pillow poking above a sofa back), or
        the whole hull for flat things under other furniture (extent="hull", rugs)."""
        m = self.masks[nid]
        pts = cv2.findNonZero(m.astype(np.uint8))
        hull = np.zeros(self.shape, np.uint8)
        cv2.fillConvexPoly(hull, cv2.convexHull(pts), 1)
        hull = hull > 0
        if self.nodes[nid].get("extent") == "hull":
            return hull
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, disk(15 * self.s)) > 0
        m |= hull & dilate(self.core[nid], 12 * self.s)
        inv = (~m).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, 4)
        H, W = self.shape
        for i in range(1, n):
            x, y, w, h, _ = stats[i]
            if x > 0 and y > 0 and x + w < W and y + h < H:
                m[lab == i] = True
        return m

    def hole(self, units, keep_extras=True):
        h = np.zeros(self.shape, bool)
        for u in units:
            h |= self.alpha0[u] > 0
        if keep_extras:
            h &= ~(dilate(self.extras, 2) & ~np.any([self.inner(u) for u in units], axis=0))
        return h


def build_plate(lama, base, R, units, region=None, order="large", band=48, ctx=0.5, max_side=1024,
                refine_max=0.03, protect_extras=True):
    """Shared clean plate for a cluster, filled one piece at a time.

    One LaMa pass over the whole cluster turns big holes into fog. Instead each piece (an
    object plus its attachments) is filled with a small hole: its own support. A band of the
    still-present pieces next to it is masked too, so LaMa does not continue their texture into
    the hole. Only the piece's support (minus the still-present pieces) is committed. Those are
    refilled when their turn comes. Small pieces are then refined once more with clean context.
    The result is still a single image shared by every member of the cluster, so patches compose.
    `region` limits the work to a parent's extent (child-level plates).
    """
    H, W = base.shape[:2]
    img = base.copy()
    protect = dilate(R.extras, 2) if protect_extras else np.zeros((H, W), bool)
    # visible objects outside this cluster (other than the ancestors being kept) stay as context
    inside = {k for u in units for k in R.fam[u]}
    keep_anc = set().union(*(R.anc[u] for u in units)) if units else set()
    others = np.zeros((H, W), bool)
    for k in R.nodes:
        if k not in inside and k not in keep_anc and (protect_extras or R.nodes[k]["kind"] != "extra"):
            others |= R.masks[k]
    protect |= dilate(others, 2)
    # Pieces: every listed object of every unit's family, together with its attachments (a white
    # pillow stacked behind a patterned one is filled in the same pass). Parents before children,
    # large before small; each pass only fills one piece's own support, so no single LaMa call
    # sees a giant hole.
    fam_nodes = [k for u in units for k in R.fam[u]]
    pieces = [k for k in fam_nodes if R.nodes[k]["kind"] != "attach" or R.nodes[k]["parent"] not in fam_nodes]
    pmask = {k: R.masks[k] | np.any([R.masks[a] for a in fam_nodes if R.nodes[a]["kind"] == "attach"
                                     and R.nodes[a]["parent"] == k] or [np.zeros((H, W), bool)], axis=0)
             for k in pieces}
    psup = {k: R._feather(pmask[k], R.nodes[k]) > 0 for k in pieces}
    if isinstance(order, (list, tuple)):
        seq = [k for k in order if k in pieces] + [k for k in pieces if k not in order]
    else:
        sign = -1 if order == "large" else 1
        seq = sorted(pieces, key=lambda k: (len(R.anc[k]), sign * int(pmask[k].sum())))
    remaining = set(seq)
    done = np.zeros((H, W), bool)
    for k in seq:
        remaining.discard(k)
        sup = psup[k] & ~(protect & ~dilate(pmask[k], 5 * R.s))
        rest = np.zeros((H, W), bool)
        for r in remaining:
            rest |= pmask[r]
        hole = sup | (rest & dilate(sup, band * R.s))
        commit = sup & ~rest
        if region is not None:
            hole &= region
            commit &= region
        if not commit.any():
            continue
        filled = inpaint_region(lama, img, hole, ctx=ctx, max_side=max_side)
        img[commit] = filled[commit]
        done |= commit
    # pixels of the cluster's hole that no single piece's support covered (the feather of a
    # union reaches slightly further than the union of feathers)
    left = R.hole(units, keep_extras=protect_extras) & ~protect & ~done
    if region is not None:
        left &= region
    if left.any():
        filled = inpaint_region(lama, img, left | (dilate(left, 8) & done), ctx=ctx, max_side=max_side)
        img[left] = filled[left]
    # Refinement: with everything in the cluster gone, re-fill each small piece (lamp, pillow,
    # vase, ...) with its own small hole. Its surroundings are now real background or clean
    # fill, so LaMa continues e.g. a window railing instead of smearing it.
    for k in sorted(pieces, key=lambda k: pmask[k].sum()):
        if pmask[k].mean() > refine_max:
            continue
        hole = psup[k] & ~(protect & ~dilate(pmask[k], 5 * R.s))
        if region is not None:
            hole &= region
        if hole.any():
            filled = inpaint_region(lama, img, hole, ctx=1.0, max_side=max_side)
            img[hole] = filled[hole]
    return img


def stage_remove(sid, spec, work: Path, lama, only=None):
    rgb, icc = load_original(sid)
    H, W = rgb.shape[:2]
    masks = load_masks(sid, spec, work)
    R = Removal(spec, masks, (H, W))
    out_dir = SAMPLES_DIR / sid / "remove"
    rdir = work / sid / "removed"
    rdir.mkdir(parents=True, exist_ok=True)
    meta_f = work / sid / "removal_meta.json"
    meta = json.loads(meta_f.read_text()) if meta_f.exists() else {}
    plates, plate_of = {}, {}
    pdir = work / sid / "plates"
    pdir.mkdir(exist_ok=True)
    # parents before children: a child's plate reuses its parent's plate outside the parent
    ordered = sorted(spec["objects"], key=lambda o: len(R.anc[o["id"]]))
    for o in ordered:
        oid = o["id"]
        t = time.time()
        units = R.cluster(oid)
        key = (tuple(sorted(R.anc[oid])), tuple(units))
        if key not in plates:
            hole = R.hole(units)
            parent = R.nodes[oid]["parent"]
            kw = dict(order=spec.get("plate_order", "large"), band=spec.get("band", 48),
                      ctx=spec.get("ctx", 0.5), max_side=spec.get("max_side", 1024))
            if parent is None:
                plate = build_plate(lama, rgb, R, units, **kw)
            else:
                # Outside the parent: identical to the parent's plate, so a child's patch and its
                # parent's neighbours' patches agree pixel for pixel. On the parent: LaMa
                # regenerates the parent's surface (sofa fabric under a pillow).
                region = R.extent(parent)
                base = rgb.copy()
                outside = hole & ~region
                base[outside] = plate_of[parent][outside]
                plate = build_plate(lama, base, R, units, region=region, **kw)
            plates[key] = plate
            name = f"plate{len(plates)}"
            cv2.imwrite(str(pdir / f"{name}.png"), cv2.cvtColor(plate, cv2.COLOR_RGB2BGR))
            log(f"[{sid}] plate {name}: keep={list(key[0])} units={list(units)} "
                f"hole={hole.mean() * 100:.1f}% ({time.time() - t:.1f}s)")
        plate_of[oid] = plates[key]
        if only and oid not in only:
            continue
        plate = plates[key]
        alpha = R.alpha(oid)
        x, y, w, h = encode_patch(plate, alpha, icc, out_dir / f"{oid}.webp")
        comp = (plate * alpha[..., None] + rgb * (1 - alpha[..., None]) + 0.5).astype(np.uint8)
        cv2.imwrite(str(rdir / f"{oid}.png"), cv2.cvtColor(comp, cv2.COLOR_RGB2BGR))
        meta[oid] = dict(patch=f"remove/{oid}.webp", x=x, y=y, w=w, h=h)
        log(f"[{sid}] patch {oid:22s} {w}x{h}@({x},{y}) {(out_dir / f'{oid}.webp').stat().st_size / 1024:.0f} KB")
    meta_f.write_text(json.dumps(meta, indent=1))
    return meta


def stage_declutter(sid, spec, work: Path, lama):
    """All movable things (listed objects + extras) removed, built like the patch plates:
    each touching group is filled one unit at a time."""
    rgb, icc = load_original(sid)
    H, W = rgb.shape[:2]
    masks = load_masks(sid, spec, work)
    R = Removal(spec, masks, (H, W))
    dc = spec.get("declutter", {})
    tops = [k for k, n in R.nodes.items() if n["parent"] is None]
    t = time.time()
    plate = rgb.copy()
    alpha = np.zeros((H, W), np.float32)
    seen = set()
    for k in tops:
        if k in seen:
            continue
        units = R.cluster(k, with_extras=True)
        seen |= set(units)
        filled = build_plate(lama, rgb, R, units, protect_extras=False, order=dc.get("order", "large"),
                             ctx=dc.get("ctx", 0.5), max_side=dc.get("max_side", 1024))
        hole = R.hole(units, keep_extras=False)
        plate[hole] = filled[hole]
        for u in units:
            alpha = np.maximum(alpha, R.alpha0[u])
    out = (plate * alpha[..., None] + rgb * (1 - alpha[..., None]) + 0.5).astype(np.uint8)
    cv2.imwrite(str(work / sid / "declutter_candidate.png"), cv2.cvtColor(out, cv2.COLOR_RGB2BGR))
    log(f"[{sid}] declutter candidate ({time.time() - t:.1f}s)")
    return out, icc


# ----------------------------------------------------------------------------
# Stage 4: inventory.json (+ declutter.jpg when the spec opts in)
# ----------------------------------------------------------------------------
def stage_write(sid, spec, work: Path):
    rgb, icc = load_original(sid)
    H, W = rgb.shape[:2]
    masks = load_masks(sid, spec, work)
    rmeta = json.loads((work / sid / "removal_meta.json").read_text())
    objs = []
    for o in spec["objects"]:
        oid = o["id"]
        assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*-\d+", oid), oid
        objs.append({
            "id": oid,
            "label": label_of(oid),
            "box_2d": mask_to_box2d(masks[oid]),
            "mask": mask_to_polygon(masks[oid]),
            "children": list(o.get("children", [])),
            "removal": rmeta[oid],
        })
    inv = {"id": sid, "title": spec["title"], "roomType": spec["roomType"], "width": W, "height": H,
           "source": SOURCE, "objects": objs}
    assert spec["roomType"] in ROOM_TYPES
    dpath = SAMPLES_DIR / sid / "declutter.jpg"
    cand = work / sid / "declutter_candidate.png"
    if spec.get("declutter", {}).get("publish") and cand.exists():
        im = Image.fromarray(cv2.cvtColor(cv2.imread(str(cand)), cv2.COLOR_BGR2RGB))
        kw = dict(quality=88, optimize=True, progressive=True)
        if icc:
            kw["icc_profile"] = icc
        im.save(dpath, "JPEG", **kw)
        inv["declutter"] = "declutter.jpg"
    elif dpath.exists():
        dpath.unlink()
    # drop stale patches from earlier runs
    keep = {Path(r["removal"]["patch"]).name for r in objs}
    for f in (SAMPLES_DIR / sid / "remove").glob("*.webp"):
        if f.name not in keep:
            f.unlink()
    (SAMPLES_DIR / sid / "inventory.json").write_text(json.dumps(inv, separators=(",", ":")) + "\n")
    log(f"[{sid}] wrote inventory.json ({len(objs)} objects, declutter={'declutter' in inv}, "
        f"ICC {icc_name(icc)})")
    return inv


# ----------------------------------------------------------------------------
# Stage 5: verification (browser-style compositing from the files on disk) + contact sheets
# ----------------------------------------------------------------------------
PALETTE = [(230, 25, 75), (60, 180, 75), (255, 225, 25), (0, 130, 200), (245, 130, 48), (145, 30, 180),
           (70, 240, 240), (240, 50, 230), (210, 245, 60), (250, 190, 212), (0, 128, 128), (220, 190, 255),
           (170, 110, 40), (255, 250, 200)]


def browser_composite(orig: np.ndarray, patch_rgba: np.ndarray, x: int, y: int) -> np.ndarray:
    """Canvas drawImage(patch, x, y): source-over with straight alpha, 8-bit result."""
    out = orig.astype(np.float32).copy()
    h, w = patch_rgba.shape[:2]
    a = patch_rgba[..., 3:4].astype(np.float32) / 255.0
    out[y:y + h, x:x + w] = patch_rgba[..., :3] * a + out[y:y + h, x:x + w] * (1 - a)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def stage_verify(sid, spec, work: Path):
    inv = json.loads((SAMPLES_DIR / sid / "inventory.json").read_text())
    orig, icc = load_original(sid)
    H, W = orig.shape[:2]
    assert (inv["width"], inv["height"]) == (W, H)
    ids = {o["id"] for o in inv["objects"]}
    problems = []
    tiles = []
    patches = {}
    for o in inv["objects"]:
        r = o["removal"]
        pim = Image.open(SAMPLES_DIR / sid / r["patch"])
        if pim.mode != "RGBA":
            problems.append(f"{o['id']}: patch mode {pim.mode}")
        if (pim.info.get("icc_profile") or None) != (icc or None):
            problems.append(f"{o['id']}: ICC profile differs from original.jpg")
        p = np.array(pim.convert("RGBA"))
        patches[o["id"]] = p
        if p.shape[:2] != (r["h"], r["w"]):
            problems.append(f"{o['id']}: patch size {p.shape[:2]} != json {(r['h'], r['w'])}")
        if r["x"] < 0 or r["y"] < 0 or r["x"] + r["w"] > W or r["y"] + r["h"] > H:
            problems.append(f"{o['id']}: patch outside image")
        for c in o["children"]:
            if c not in ids:
                problems.append(f"{o['id']}: unknown child {c}")
        comp = browser_composite(orig, p, r["x"], r["y"])
        # alignment: the browser-style composite must match the pipeline's in-memory result
        ref = cv2.cvtColor(cv2.imread(str(work / sid / "removed" / f"{o['id']}.png")), cv2.COLOR_BGR2RGB)
        diff = np.abs(comp.astype(int) - ref.astype(int))
        outside = np.ones((H, W), bool)
        outside[r["y"]:r["y"] + r["h"], r["x"]:r["x"] + r["w"]] = False
        if diff[outside].max() > 0:
            problems.append(f"{o['id']}: pixels changed outside patch rect")
        p995 = float(np.percentile(diff[~outside], 99.5))
        if p995 > 40:
            problems.append(f"{o['id']}: webp composite deviates from reference (p99.5={p995:.0f})")
        tiles.append((o, comp))

    def compose(order):
        img = orig
        for oid in order:
            r = next(o for o in inv["objects"] if o["id"] == oid)["removal"]
            img = browser_composite(img, patches[oid], r["x"], r["y"])
        return img

    # (b) everything removed. Valid orders never draw a child after its parent (removing a
    # parent removes its children), so compare: roots in list order, roots reversed, and every
    # object children-first.
    parent = {c: o["id"] for o in inv["objects"] for c in o["children"]}
    roots = [o["id"] for o in inv["objects"] if o["id"] not in parent]

    def depth(a):
        return 0 if a not in parent else 1 + depth(parent[a])
    every = sorted((o["id"] for o in inv["objects"]), key=lambda a: -depth(a))
    all_fwd, all_rev, all_every = compose(roots), compose(roots[::-1]), compose(every)
    d = np.maximum(np.abs(all_fwd.astype(int) - all_rev.astype(int)),
                   np.abs(all_fwd.astype(int) - all_every.astype(int))).max(axis=2)
    stats = {"all": (int(d.max()), float((d > 6).mean() * 100))}
    if (d > 12).mean() > 0.001:
        problems.append(f"all-removed differs by order: max {d.max()}, {stats['all'][1]:.3f}% px > 6")
    # (c) every pair of unrelated objects whose patches overlap, both orders

    def line(a):
        out = []
        while a in parent:
            a = parent[a]
            out.append(a)
        return out
    pairs = []
    for i, a in enumerate(inv["objects"]):
        for b in inv["objects"][i + 1:]:
            if a["id"] in line(b["id"]) or b["id"] in line(a["id"]):
                continue
            ra, rb = a["removal"], b["removal"]
            ox = min(ra["x"] + ra["w"], rb["x"] + rb["w"]) - max(ra["x"], rb["x"])
            oy = min(ra["y"] + ra["h"], rb["y"] + rb["h"]) - max(ra["y"], rb["y"])
            if ox > 0 and oy > 0:
                ab, ba = compose([a["id"], b["id"]]), compose([b["id"], a["id"]])
                dd = np.abs(ab.astype(int) - ba.astype(int)).max(axis=2)
                pairs.append((ox * oy, a["id"], b["id"], ab, ba, int(dd.max()), int((dd > 6).sum())))
                if (dd > 12).sum() > 50:
                    problems.append(f"pair {a['id']}+{b['id']}: order-dependent ({(dd > 12).sum()} px differ > 12)")
    pairs.sort(key=lambda t: -t[0])
    log(f"[{sid}] composability: all-removed fwd/rev max diff {stats['all'][0]} ({stats['all'][1]:.3f}% px > 6); "
        f"{len(pairs)} overlapping pairs, worst max diff {max([p[5] for p in pairs], default=0)}")
    for _, a, b, _, _, mx, n6 in pairs:
        log(f"[{sid}]   pair {a} + {b}: max diff {mx}, {n6} px > 6")
    contact_sheet(sid, inv, orig, tiles, work)
    combos_sheet(sid, orig, all_fwd, pairs, work)
    status = "OK" if not problems else "PROBLEMS:\n  " + "\n  ".join(problems)
    log(f"[{sid}] verify {status}")
    return problems


def combos_sheet(sid, orig, all_fwd, pairs, work: Path):
    H, W = orig.shape[:2]
    bgr = lambda a: cv2.cvtColor(a, cv2.COLOR_RGB2BGR)
    rows = [np.hstack([bgr(orig), np.full((H, 6, 3), 255, np.uint8), bgr(all_fwd)])]
    for _, a, b, ab, ba, mx, n6 in pairs[:4]:
        row = np.hstack([bgr(ab), np.full((H, 6, 3), 255, np.uint8), bgr(ba)])
        cv2.putText(row, f"{a} then {b}", (10, 30), 0, 0.9, (0, 0, 0), 4)
        cv2.putText(row, f"{a} then {b}", (10, 30), 0, 0.9, (255, 255, 255), 2)
        cv2.putText(row, f"{b} then {a}  (max diff {mx})", (W + 16, 30), 0, 0.9, (0, 0, 0), 4)
        cv2.putText(row, f"{b} then {a}  (max diff {mx})", (W + 16, 30), 0, 0.9, (255, 255, 255), 2)
        rows.append(row)
    sheet = np.vstack([np.vstack([r, np.full((6, r.shape[1], 3), 255, np.uint8)]) for r in rows])
    sc = 1400 / sheet.shape[1]
    sheet = cv2.resize(sheet, (1400, int(sheet.shape[0] * sc)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(work / f"contact-{sid}-combos.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])


def contact_sheet(sid, inv, orig, tiles, work: Path):
    H, W = orig.shape[:2]
    bgr = cv2.cvtColor(orig, cv2.COLOR_RGB2BGR)
    ov = bgr.copy()
    for i, o in enumerate(inv["objects"]):
        col = PALETTE[i % len(PALETTE)][::-1]
        pts = np.array([[x / 1000 * (W - 1), y / 1000 * (H - 1)] for x, y in o["mask"]], np.int32)
        fill = ov.copy()
        cv2.fillPoly(fill, [pts], col)
        ov = cv2.addWeighted(fill, 0.18, ov, 0.82, 0)
        cv2.polylines(ov, [pts], True, col, 2, cv2.LINE_AA)
    for i, o in enumerate(inv["objects"]):
        col = PALETTE[i % len(PALETTE)][::-1]
        ymin, xmin = o["box_2d"][0] / 1000 * H, o["box_2d"][1] / 1000 * W
        txt = f"{o['id']} ({len(o['mask'])}pt)"
        (tw, th), _ = cv2.getTextSize(txt, 0, 0.5, 1)
        tx, ty = int(xmin) + 2, max(14, int(ymin) + 14)
        cv2.rectangle(ov, (tx - 2, ty - th - 3), (tx + tw + 2, ty + 3), (0, 0, 0), -1)
        cv2.putText(ov, txt, (tx, ty), 0, 0.5, col, 1, cv2.LINE_AA)
    cv2.imwrite(str(work / f"contact-{sid}-masks.jpg"), ov, [cv2.IMWRITE_JPEG_QUALITY, 85])
    # removal grid: before | after crops around each patch
    cells = []
    cw = 520
    for o, comp in tiles:
        r = o["removal"]
        m = 30
        x0, y0 = max(0, r["x"] - m), max(0, r["y"] - m)
        x1, y1 = min(W, r["x"] + r["w"] + m), min(H, r["y"] + r["h"] + m)
        a = bgr[y0:y1, x0:x1]
        b = cv2.cvtColor(comp, cv2.COLOR_RGB2BGR)[y0:y1, x0:x1]
        pair = np.hstack([a, np.full((a.shape[0], 4, 3), 255, np.uint8), b])
        sc = cw / pair.shape[1]
        pair = cv2.resize(pair, (cw, max(1, int(pair.shape[0] * sc))), interpolation=cv2.INTER_AREA)
        lab = np.zeros((22, cw, 3), np.uint8)
        cv2.putText(lab, f"{o['id']}  (+{', '.join(o['children']) or 'no children'})", (4, 16), 0, 0.5,
                    (255, 255, 255), 1, cv2.LINE_AA)
        cells.append(np.vstack([lab, pair]))
    cols = 2
    rows = []
    for i in range(0, len(cells), cols):
        row = cells[i:i + cols]
        hmax = max(c.shape[0] for c in row)
        row = [np.vstack([c, np.zeros((hmax - c.shape[0], cw, 3), np.uint8)]) for c in row]
        while len(row) < cols:
            row.append(np.zeros((hmax, cw, 3), np.uint8))
        rows.append(np.hstack([row[0]] + [np.hstack([np.zeros((hmax, 6, 3), np.uint8), c]) for c in row[1:]]))
    grid = np.vstack([np.vstack([r, np.zeros((6, r.shape[1], 3), np.uint8)]) for r in rows])
    cv2.imwrite(str(work / f"contact-{sid}-removals.jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 85])
    dc = SAMPLES_DIR / sid / "declutter.jpg"
    cand = work / sid / "declutter_candidate.png"
    src = dc if dc.exists() else cand
    if src.exists():
        d = cv2.imread(str(src))
        both = np.hstack([bgr, np.full((H, 6, 3), 255, np.uint8), d])
        sc = 1600 / both.shape[1]
        both = cv2.resize(both, (1600, int(both.shape[0] * sc)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(work / f"contact-{sid}-declutter.jpg"), both, [cv2.IMWRITE_JPEG_QUALITY, 85])


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, help="scratch dir for caches, masks and contact sheets")
    ap.add_argument("--samples", nargs="*", default=list(SPECS))
    ap.add_argument("--stages", default="detect,segment,remove,declutter,write,verify")
    ap.add_argument("--only", nargs="*", help="limit 'remove' to these object ids")
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    args = ap.parse_args()
    import torch

    torch.set_num_threads(args.threads)
    work = Path(args.work).resolve()
    if REPO in work.parents or work == REPO:
        raise SystemExit("--work must be outside the repository")
    stages = args.stages.split(",")
    lama = Lama() if {"remove", "declutter"} & set(stages) else None
    all_problems = {}
    for sid in args.samples:
        spec = SPECS[sid]
        (work / sid).mkdir(parents=True, exist_ok=True)
        dets = stage_detect(sid, spec, work) if "detect" in stages or "segment" in stages else None
        if "candidates" in stages:
            draw_candidates(sid, stage_detect(sid, spec, work), work)
        if "segment" in stages:
            stage_segment(sid, spec, dets, work)
        if "remove" in stages:
            stage_remove(sid, spec, work, lama, only=args.only)
        if "declutter" in stages and "declutter" in spec:
            stage_declutter(sid, spec, work, lama)
        if "write" in stages:
            stage_write(sid, spec, work)
        if "verify" in stages:
            all_problems[sid] = stage_verify(sid, spec, work)
    if "verify" in stages:
        total = sum(f.stat().st_size for s in args.samples for f in (SAMPLES_DIR / s).rglob("*")
                    if f.is_file() and f.name not in ("original.jpg", "legacy-prototype.jpg"))
        log(f"generated bytes for {args.samples}: {total} ({total / 1e6:.2f} MB)")
        if any(all_problems.values()):
            sys.exit(1)


if __name__ == "__main__":
    main()
