"""The headless outcome convention: one structured result line on stdout and a matching
exit code for every run with -s -t -o. All paths use small local files and fakes only -
no model downloads, no GPU, no ffmpeg."""
import os

from changeling import outcome

from conftest import core, face_analyser, parse_result, predictor, write_image


def check(job, capsys, argv):
    """Run once and return (exit code, parsed result line); the two must always agree."""
    code = job.run(*argv)
    result = parse_result(capsys.readouterr().out)
    assert outcome.EXIT_CODES[result['status']] == code
    assert result['reason']
    return code, result


def test_image_swap_succeeds(job, capsys, tmp_path):
    source = tmp_path / 'source.png'
    target = tmp_path / 'target.png'
    output = tmp_path / 'out.png'
    write_image(source)
    write_image(target)

    code, result = check(job, capsys, ['-s', source, '-t', target, '-o', output])

    assert code == 0
    assert result['status'] == outcome.SUCCESS
    assert result['output'] == str(output)
    assert os.path.isfile(output)


def test_source_without_face_is_invalid_input(job, capsys, tmp_path):
    source = tmp_path / 'source.png'
    target = tmp_path / 'target.png'
    output = tmp_path / 'out.png'
    write_image(source)
    write_image(target)
    face_analyser.HAS_FACE = False

    code, result = check(job, capsys, ['-s', source, '-t', target, '-o', output])

    assert code == 2
    assert result['status'] == outcome.INVALID_INPUT
    assert 'face' in result['reason'].lower()
    assert result['output'] is None
    assert not os.path.exists(output)


def test_unsupported_target_extension_is_invalid_input(job, capsys, tmp_path):
    source = tmp_path / 'source.png'
    target = tmp_path / 'target.txt'  # neither an image nor a video
    output = tmp_path / 'out.png'
    write_image(source)
    target.write_text('not a video')

    code, result = check(job, capsys, ['-s', source, '-t', target, '-o', output])

    assert code == 2
    assert result['status'] == outcome.INVALID_INPUT
    assert result['output'] is None
    assert not os.path.exists(output)


def test_empty_frame_extraction_fails_and_cleans_temp(job, capsys, tmp_path, monkeypatch):
    source = tmp_path / 'source.png'
    target = tmp_path / 'target.mp4'
    output = tmp_path / 'out.mp4'
    write_image(source)
    target.write_bytes(b'')  # a video by extension; nothing can be extracted from it
    monkeypatch.setattr(core, 'extract_frames', lambda *args, **kwargs: True)  # extracts nothing

    code, result = check(job, capsys, ['-s', source, '-t', target, '-o', output])

    assert code == 1
    assert result['status'] == outcome.FAILED
    assert 'frames' in result['reason'].lower()
    assert result['output'] is None
    assert not os.path.exists(output)
    assert not os.path.exists(tmp_path / 'temp')  # the temp frame directory is cleaned up


def test_stale_output_file_is_not_a_success(job, capsys, tmp_path, monkeypatch):
    source = tmp_path / 'source.png'
    target = tmp_path / 'target.mp4'
    output = tmp_path / 'out.mp4'
    write_image(source)
    target.write_bytes(b'')
    output.write_bytes(b'old')  # left over from an earlier run

    def fake_extract_frames(target_path, *args, **kwargs):
        from changeling.utilities import get_temp_directory_path
        write_image(os.path.join(get_temp_directory_path(target_path), '0001.png'))

    monkeypatch.setattr(core, 'extract_frames', fake_extract_frames)
    monkeypatch.setattr(core, 'create_video', lambda *args, **kwargs: True)  # never makes temp.mp4

    code, result = check(job, capsys, ['-s', source, '-t', target, '-o', output])

    assert code == 1
    assert result['status'] == outcome.FAILED
    assert result['output'] is None
    assert output.read_bytes() == b'old'  # the old file is untouched, not claimed as this run's
    assert not os.path.exists(tmp_path / 'temp')


def test_nsfw_target_is_refused(job, capsys, tmp_path):
    source = tmp_path / 'source.png'
    target = tmp_path / 'target.png'
    output = tmp_path / 'out.png'
    write_image(source)
    write_image(target)
    predictor.FLAGGED = True

    code, result = check(job, capsys, ['-s', source, '-t', target, '-o', output])

    assert code == 3
    assert result['status'] == outcome.REFUSED
    assert result['output'] is None
    assert not os.path.exists(output)
