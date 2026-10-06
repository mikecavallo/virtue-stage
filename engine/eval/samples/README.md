# Evaluation samples

Five real photos of empty (or nearly empty) rooms used by `python -m eval.run`. Every file here is
freely licensed; source, author and license for each are listed in `LICENSES.md`. These are
downscaled copies of the originals.

## Adding your own

1. Use photos you have the right to use (your own listings with the owner's permission, or
   CC0 / CC BY / CC BY-SA images from Wikimedia Commons, Unsplash or Pexels).
2. Prefer typical listing shots: wide angle, eye-level camera, daylight, a mix of room types
   (living, bedroom, dining, kitchen, bathroom, patio) and a few partially furnished rooms to
   exercise `--mode declutter_stage`.
3. Keep them around 1600-2000 px on the long side, JPEG.
4. Add a row to `LICENSES.md` (file, source URL, author, license, changes).
5. Do not commit client photos to a public repo; keep those in a local folder and pass it with
   `--images /path/to/folder`.
