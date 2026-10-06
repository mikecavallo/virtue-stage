from eval.run import main
from synthetic import draw_room


def test_eval_harness_runs_offline_and_writes_report(tmp_path):
    imgs = tmp_path / "imgs"
    imgs.mkdir()
    draw_room((900, 600)).save(imgs / "a.jpg")
    draw_room((600, 800), seed=2).save(imgs / "b.png")
    out = tmp_path / "out"
    assert main(["--images", str(imgs), "--styles", "modern,coastal", "--provider", "fake", "--out", str(out),
                 "--candidates", "1"]) == 0
    report = (out / "report.html").read_text()
    assert report.count("class='card'") == 4
    assert "Provider is <b>fake</b>" in report
    assert (out / "a__coastal__after.jpg").exists() and (out / "results.json").exists()
