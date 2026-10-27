#!/usr/bin/env python3
"""Precompute VirtueStage demo-mode assets (segmentation + object removal).

For every sample photo in app/public/samples/<id>/original.jpg this writes:

  inventory.json      objects with Gemini-style box_2d / mask polygons (0-1000)
  remove/<obj>.webp   RGBA patches: inpainted pixels, alpha = feathered removal mask
  declutter.jpg       (optional) the room with all movable furniture removed

Pipeline: Grounding DINO (open-vocabulary boxes) -> SAM ViT-H (box-prompted
masks) -> mask cleanup -> big-LaMa inpainting on a context crop around each
object. See README.md for details, model IDs and licenses.

The object list for each photo is curated in SPECS below: each object has a
Grounding DINO phrase plus a hand-placed hint box that selects which detection
to keep (and is used as the SAM prompt only if DINO misses the object).

Usage:
  python generate.py --work /path/to/scratch [--samples living-room bedroom]
                     [--stages detect,segment,remove,write,verify]
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
ROOM_TYPES = {"living-room", "bedroom", "kitchen", "dining-room", "bathroom"}


# ----------------------------------------------------------------------------
# Per-photo object specs. Coordinates are pixels in original.jpg.
#   id        "<label-slug>-<n>"; the label is derived from it ("throw-pillow-1" -> "throw pillow")
#   prompt    Grounding DINO phrase used to find it
#   hint      rough (x0, y0, x1, y1) box that picks the matching detection
#   children  ids of listed objects resting on it (removed together with it)
#   attach    unlisted bits removed together with it: dicts with prompt/hint (+ SAM options)
#   points    extra SAM clicks [(x, y, 1=include | 0=exclude), ...]
#   mask      which of SAM's 3 multimask outputs to use ("best" = highest predicted IoU)
#   box       "det" (default: DINO box, hint as fallback) or "hint" (force the hint box)
#   subtract  ids whose masks are removed from this one (overlap cleanup)
#   surface   True for rugs: other objects' removals may repaint over it
#   halo/bottom/sigma/ctx/max_side  removal tuning (see removal_masks / inpaint_region)
# "extra" entries are not listed in the inventory but are removed in declutter.jpg.
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
            O("dining-chair-1", "dining chair", (1024, 404, 1200, 709), points=[(1125, 610, 0)]),
            O("dining-chair-2", "dining chair", (901, 383, 1036, 597)),
            O("dining-chair-3", "dining chair", (938, 375, 1028, 487)),
            O("potted-plant-1", "potted plant", (900, 285, 968, 392)),
            O("wall-art-1", "framed picture", (775, 278, 838, 320)),
            O("wall-art-2", "framed picture", (1040, 295, 1147, 343)),
        ],
        extra=[
            X("sofa", (989, 362, 1146, 423)),
            X("armchair", (719, 370, 794, 453)),
            X("potted plant", (720, 395, 770, 460)),
            X("coffee table", (850, 406, 913, 470)),
            X("rug", (796, 434, 919, 489), surface=True),
            X("table lamp", (954, 340, 986, 377)),
            X("table lamp", (1128, 343, 1188, 380)),
            X("dining table", (976, 415, 1200, 630)),
            X("dining chair", (1108, 376, 1200, 429)),
        ],
        declutter=dict(),
    ),
    # NOTE: despite the folder name this photo is an open-plan living room (leather sofa).
    "bedroom": dict(
        title="Open-plan living room", roomType="living-room",
        objects=[
            O("sofa-1", "sofa", (193, 463, 776, 745),
              children=["throw-pillow-1", "throw-pillow-2", "throw-blanket-1"]),
            O("throw-pillow-1", "pillow", (270, 478, 415, 588)),
            O("throw-pillow-2", "pillow", (616, 460, 705, 543)),
            O("throw-blanket-1", "blanket", (183, 505, 320, 650)),
            O("armchair-1", "armchair", (951, 466, 1200, 712), children=["throw-pillow-3"]),
            O("throw-pillow-3", "pillow", (1029, 466, 1173, 584)),
            O("side-table-1", "side table", (745, 514, 806, 632)),
            O("potted-plant-1", "potted plant", (830, 428, 945, 590)),
            O("potted-plant-2", "potted plant", (700, 440, 755, 495)),
            O("sideboard-1", "sideboard", (757, 468, 850, 585)),
            O("mirror-1", "round mirror", (800, 315, 878, 412)),
            O("wall-art-1", "wall hanging", (681, 198, 730, 452)),
        ],
        extra=[
            X("potted plant", (0, 400, 185, 745)),
            X("side table", (54, 539, 192, 756)),
            X("chair", (1, 638, 287, 799)),
        ],
        declutter=dict(),
    ),
    # NOTE: two people cooking dominate this photo; only cookware/decor is tappable.
    "kitchen": dict(
        title="Kitchen", roomType="kitchen",
        objects=[
            O("dutch-oven-1", "dutch oven", (30, 168, 145, 232)),
            O("dutch-oven-2", "dutch oven", (33, 490, 158, 560)),
            O("stock-pot-1", "pot", (505, 578, 710, 750)),
            O("saucepan-1", "saucepan", (252, 618, 412, 732)),
            O("bell-peppers-1", "bell pepper", (108, 703, 210, 797)),
            O("avocado-1", "avocado", (60, 735, 118, 795)),
            O("pepper-mill-1", "pepper mill", (575, 705, 635, 800)),
            O("pepper-mill-2", "pepper mill", (650, 710, 712, 800)),
            O("plates-1", "plates", (45, 350, 125, 373)),
            O("casserole-dish-1", "casserole dish", (700, 232, 778, 268)),
            O("potted-plant-1", "potted plant", (652, 210, 705, 262)),
            O("dining-table-1", "dining table", (1050, 550, 1200, 800)),
        ],
    ),
    # NOTE: despite the folder name this photo is a bedroom.
    "dining-room": dict(
        title="Bedroom", roomType="bedroom",
        objects=[
            O("bed-1", "bed", (231, 394, 874, 798), children=["throw-pillow-1", "throw-pillow-2"]),
            O("throw-pillow-1", "pillow", (451, 418, 550, 485)),
            O("throw-pillow-2", "pillow", (392, 439, 542, 504)),
            O("nightstand-1", "nightstand", (77, 535, 280, 737), children=["table-lamp-1"],
              attach=[X("ball", (215, 508, 253, 540)), X("book", (195, 530, 275, 555))]),
            O("table-lamp-1", "table lamp", (116, 393, 236, 552)),
            O("table-lamp-2", "table lamp", (516, 395, 574, 483)),
            O("wall-art-1", "framed picture", (290, 239, 446, 377)),
            O("accent-chair-1", "chair", (875, 469, 1149, 705), children=["throw-pillow-3"]),
            O("throw-pillow-3", "pillow", (973, 466, 1089, 565)),
            O("side-table-1", "side table", (1011, 530, 1199, 767), children=["vase-1"],
              attach=[X("books", (1049, 548, 1148, 578))]),
            O("vase-1", "vase of flowers", (1052, 505, 1135, 562)),
            O("area-rug-1", "rug", (198, 608, 1176, 799), surface=True),
        ],
        declutter=dict(),
    ),
    "bathroom": dict(
        title="Bathroom", roomType="bathroom",
        objects=[
            O("potted-plant-1", "potted plant", (0, 1155, 325, 1680)),
            O("step-stool-1", "step stool", (392, 1341, 642, 1705)),
            O("mirror-1", "mirror", (200, 668, 432, 976)),
            O("potted-plant-2", "plant in basket", (488, 930, 640, 1118)),
            O("hanging-plant-1", "hanging plant", (600, 925, 715, 1262)),
            O("hanging-plant-2", "hanging plant", (995, 275, 1200, 750)),
            O("planter-1", "bowl", (698, 1058, 752, 1112)),
            O("waste-bin-1", "trash can", (772, 1438, 865, 1500)),
            O("jar-1", "jar", (920, 1400, 985, 1525)),
        ],
        declutter=dict(),
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
        nid = f"extra~{i}"
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
    prompts = sorted({n["prompt"] for n in nodes.values() if n.get("prompt")})
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
    meta = {}
    raw = {}
    for nid, n in nodes.items():
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
        raw[nid] = m
        meta[nid] = dict(box=[round(v, 1) for v in box], box_src=src, det_iou=round(iou, 3),
                         sam_scores=[round(s, 3) for s in scores], sam_pick=k)
    for nid, n in nodes.items():  # overlap cleanup
        m = raw[nid].copy()
        for other in n.get("subtract", []):
            m &= ~raw[other]
        cv2.imwrite(str(mdir / f"{nid}.png"), m.astype(np.uint8) * 255)
        meta[nid]["area_frac"] = round(float(m.mean()), 5)
        log(f"[{sid}] {nid:22s} {meta[nid]['box_src']:13s} iou={meta[nid]['det_iou']:.2f} "
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
    pts = approx[:, 0, :].astype(float)
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


def removal_masks(nodes, masks, nid, shape, width):
    """Return (core, alpha float32, hole) for removing node nid together with its descendants."""
    n = nodes[nid]
    fam = set(descendants(nodes, nid))
    anc = set(ancestors(nodes, nid))
    core = np.zeros(shape, bool)
    for k in fam:
        core |= masks[k]
    excl = np.zeros(shape, bool)
    for k, o in nodes.items():
        if k in fam or k in anc or o.get("surface") or o["kind"] == "extra" and o.get("surface"):
            continue
        excl |= masks[k]
    excl = dilate(excl, 2) & ~core
    s = width / 1200.0
    halo = n.get("halo", 14) * s           # px swallowed around the object (edge halos)
    bottom = n.get("bottom", 10) * s       # extra px below it (contact shadows)
    sigma = n.get("sigma", 6) * s          # feather
    hard = shift_down(dilate(core, halo), int(round(bottom)))
    # blur a mask grown by 2 sigma so alpha is ~1 over `hard` and fades out beyond it
    grown = dilate(hard, 2 * sigma)
    alpha = cv2.GaussianBlur(grown.astype(np.float32), (0, 0), sigma)
    alpha[hard] = 1.0
    alpha[excl] = 0.0
    alpha[alpha < 1.5 / 255] = 0.0
    hole = (alpha > 0) & ~excl
    return core, alpha, hole


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


def stage_remove(sid, spec, work: Path, lama, only=None):
    rgb, icc = load_original(sid)
    H, W = rgb.shape[:2]
    nodes = nodes_for(spec)
    masks = load_masks(sid, spec, work)
    out_dir = SAMPLES_DIR / sid / "remove"
    rdir = work / sid / "removed"
    rdir.mkdir(parents=True, exist_ok=True)
    meta_f = work / sid / "removal_meta.json"
    meta = json.loads(meta_f.read_text()) if meta_f.exists() else {}
    for o in spec["objects"]:
        oid = o["id"]
        if only and oid not in only:
            continue
        t = time.time()
        core, alpha, hole = removal_masks(nodes, masks, oid, (H, W), W)
        filled = inpaint_region(lama, rgb, hole, ctx=o.get("ctx", 0.6), max_side=o.get("max_side", 1024))
        x, y, w, h = encode_patch(filled, alpha, icc, out_dir / f"{oid}.webp")
        comp = (filled * alpha[..., None] + rgb * (1 - alpha[..., None]) + 0.5).astype(np.uint8)
        cv2.imwrite(str(rdir / f"{oid}.png"), cv2.cvtColor(comp, cv2.COLOR_RGB2BGR))
        meta[oid] = dict(patch=f"remove/{oid}.webp", x=x, y=y, w=w, h=h)
        log(f"[{sid}] removed {oid:22s} patch {w}x{h}@({x},{y}) "
            f"{(out_dir / f'{oid}.webp').stat().st_size / 1024:.0f} KB ({time.time() - t:.1f}s)")
    meta_f.write_text(json.dumps(meta, indent=1))
    return meta


def stage_declutter(sid, spec, work: Path, lama):
    rgb, icc = load_original(sid)
    H, W = rgb.shape[:2]
    nodes = nodes_for(spec)
    masks = load_masks(sid, spec, work)
    dc = spec.get("declutter", {})
    s = W / 1200.0
    core = np.zeros((H, W), bool)
    for k in nodes:
        core |= masks[k]
    hard = shift_down(dilate(core, dc.get("halo", 14) * s), int(dc.get("bottom", 10) * s))
    t = time.time()
    if dc.get("mode", "single") == "single":
        filled = inpaint_region(lama, rgb, hard, ctx=1.0, max_side=dc.get("max_side", 1200))
    else:  # sequential: remove groups in the given order, each pass seeing the previous result
        filled = rgb
        done = np.zeros((H, W), bool)
        for group in dc["order"]:
            g = np.zeros((H, W), bool)
            for k in group:
                for d in descendants(nodes, k):
                    g |= masks[d]
            g = shift_down(dilate(g, dc.get("halo", 14) * s), int(dc.get("bottom", 10) * s)) & ~done
            if g.any():
                filled = inpaint_region(lama, filled, g, ctx=dc.get("ctx", 0.8), max_side=dc.get("max_side", 1024))
            done |= g
        rest = hard & ~done
        if rest.any():
            filled = inpaint_region(lama, filled, rest, ctx=0.8, max_side=dc.get("max_side", 1024))
    sigma = 4 * s
    a = cv2.GaussianBlur(dilate(hard, 2 * sigma).astype(np.float32), (0, 0), sigma)
    a[hard] = 1.0
    out = (filled * a[..., None] + rgb * (1 - a[..., None]) + 0.5).astype(np.uint8)
    cv2.imwrite(str(work / sid / "declutter_candidate.png"), cv2.cvtColor(out, cv2.COLOR_RGB2BGR))
    log(f"[{sid}] declutter candidate ({time.time() - t:.1f}s, {core.mean() * 100:.1f}% of image)")
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
    log(f"[{sid}] wrote inventory.json ({len(objs)} objects, declutter={'declutter' in inv})")
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
    for o in inv["objects"]:
        r = o["removal"]
        pim = Image.open(SAMPLES_DIR / sid / r["patch"])
        if pim.mode != "RGBA":
            problems.append(f"{o['id']}: patch mode {pim.mode}")
        if (pim.info.get("icc_profile") or None) != (icc or None):
            problems.append(f"{o['id']}: ICC profile differs from original.jpg")
        p = np.array(pim.convert("RGBA"))
        if p.shape[:2] != (r["h"], r["w"]):
            problems.append(f"{o['id']}: patch size {p.shape[:2]} != json {(r['h'], r['w'])}")
        if r["x"] < 0 or r["y"] < 0 or r["x"] + r["w"] > W or r["y"] + r["h"] > H:
            problems.append(f"{o['id']}: patch outside image")
        border = np.concatenate([p[0, :, 3], p[-1, :, 3], p[:, 0, 3], p[:, -1, 3]])
        # alpha may only be non-zero on the patch border where it touches the image border
        edge_ok = [r["y"] == 0, r["y"] + r["h"] == H, r["x"] == 0, r["x"] + r["w"] == W]
        segs = [p[0, :, 3], p[-1, :, 3], p[:, 0, 3], p[:, -1, 3]]
        for ok, seg, name in zip(edge_ok, segs, "top bottom left right".split()):
            if not ok and seg.max() > 2:
                problems.append(f"{o['id']}: alpha {seg.max()} on {name} patch edge (visible seam)")
        for c in o["children"]:
            if c not in ids:
                problems.append(f"{o['id']}: unknown child {c}")
        comp = browser_composite(orig, p, r["x"], r["y"])
        # alignment: the composite must match the pipeline's in-memory result
        ref = cv2.cvtColor(cv2.imread(str(work / sid / "removed" / f"{o['id']}.png")), cv2.COLOR_BGR2RGB)
        diff = np.abs(comp.astype(int) - ref.astype(int))
        outside = np.ones((H, W), bool)
        outside[r["y"]:r["y"] + r["h"], r["x"]:r["x"] + r["w"]] = False
        if diff[outside].max() > 0:
            problems.append(f"{o['id']}: pixels changed outside patch rect")
        mean_err = float(diff.mean())
        p95 = float(np.percentile(diff[~outside], 99.5))
        if p95 > 40:
            problems.append(f"{o['id']}: webp composite deviates (p99.5={p95:.0f})")
        tiles.append((o, comp, mean_err))
    contact_sheet(sid, inv, orig, tiles, work)
    status = "OK" if not problems else "PROBLEMS:\n  " + "\n  ".join(problems)
    log(f"[{sid}] verify {status}")
    return problems


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
    for o, comp, err in tiles:
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
        if "declutter" in stages and spec.get("declutter"):
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
