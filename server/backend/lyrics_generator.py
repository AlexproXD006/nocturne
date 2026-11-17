"""
Local LRC generator using Ollama (LLM + Whisper)
"""
import os
import re
import logging
import requests
from pathlib import Path
from typing import Optional

# Ensure HuggingFace cache lives inside the project so both systemd service
# and manual CLI invocations use the same writable location.
_APP_ROOT = Path(__file__).resolve().parent.parent
_CACHE_DIR = _APP_ROOT / ".cache"
_CACHE_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HF_HOME", str(_CACHE_DIR / "huggingface"))
os.environ.setdefault("XDG_CACHE_HOME", str(_CACHE_DIR))

logger = logging.getLogger("lyrics")

# Optional: Ollama server used to time plain lyrics when Whisper is unavailable.
# If nothing listens there the LLM step is simply skipped (errors are caught).
OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

# ── Whisper model singleton (cached in memory) ───────────────
_whisper_model = None
_whisper_lock = None

def _get_cached_whisper_model():
    """Return cached WhisperModel or create one thread-safely."""
    global _whisper_model, _whisper_lock
    if _whisper_lock is None:
        import threading
        _whisper_lock = threading.Lock()
    if _whisper_model is not None:
        return _whisper_model
    with _whisper_lock:
        if _whisper_model is not None:
            return _whisper_model
        from faster_whisper import WhisperModel
        model_size, device, compute_type = _get_whisper_model()
        try:
            _whisper_model = WhisperModel(model_size, device=device, compute_type=compute_type)
            logger.info("Whisper model loaded and cached (%s/%s)", device, compute_type)
        except Exception as load_exc:
            logger.warning("Whisper load failed on %s/%s: %s", device, compute_type, load_exc)
            if device != "cpu":
                device = "cpu"
                compute_type = "int8"
                _whisper_model = WhisperModel(model_size, device=device, compute_type=compute_type)
                logger.info("Whisper fallback loaded (%s/%s)", device, compute_type)
            else:
                raise
        return _whisper_model

def get_available_models() -> list[str]:
    """Get list of available Ollama models."""
    try:
        resp = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            return [m["name"] for m in data.get("models", [])]
    except Exception as e:
        logger.warning(f"Failed to get Ollama models: {e}")
    return []


def _get_whisper_model() -> tuple[str, str, str]:
    """Return (model_size, device, compute_type) with auto GPU/CPU detection."""
    model_size = os.getenv("WHISPER_MODEL", "small").strip().lower()
    device = os.getenv("WHISPER_DEVICE", "auto").strip().lower()
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "auto").strip().lower()

    if device == "auto":
        # Detect CUDA via ctranslate2 (works even when nvidia-smi is not in PATH)
        device = "cpu"
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
        except Exception as exc:
            logger.info("CUDA detection via ctranslate2 failed: %s", exc)
            pass

    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"

    logger.info(f"Whisper config: model={model_size}, device={device}, compute={compute_type}")
    return model_size, device, compute_type


def generate_timestamps_with_llm(artist: str, title: str, lyrics: str, duration: float) -> Optional[str]:
    """
    Use LLM to generate LRC timestamps for plain lyrics.
    Returns LRC formatted string or None if failed.
    """
    try:
        model = "llama3.1:8b"
        duration_mins = duration / 60

        prompt = f"""Generate LRC format timestamps for this song.

Song: "{title}" by {artist}
Duration: {int(duration)} seconds ({duration_mins:.2f} min)

Lyrics:
{lyrics}

Rules:
- Output ONLY lines like [mm:ss.xx]lyric_text (no headers, no extra text)
- First timestamp should be around 3-10 seconds for intro
- Distribute timestamps evenly across {int(duration)} seconds
- Use format: [00:03.50]First line

Start immediately with [mm:ss.xx] format, no [ti:] or [ar:] tags."""

        resp = requests.post(
            f"{OLLAMA_BASE}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.3, "num_predict": 512}
            },
            timeout=60
        )

        if resp.status_code == 200:
            result = resp.json()
            lrc_text = result.get("response", "").strip()
            if lrc_text and "[00:" in lrc_text:
                logger.info(f"Generated LRC timestamps via Ollama for {artist} - {title}")
                return lrc_text
    except Exception as e:
        logger.warning(f"LLM timestamp generation failed: {e}")

    return None

def generate_lrc_from_audio(audio_path: str, artist: str, title: str, true_lyrics: Optional[str] = None) -> Optional[str]:
    """
    Use faster-whisper to transcribe audio and generate LRC with exact word-level timestamps.
    If true_lyrics is provided, performs forced alignment to replace transcribed words with actual lyrics.
    """
    try:
        if not os.path.exists(audio_path):
            return None

        model = _get_cached_whisper_model()

        try:
            segments, info = model.transcribe(audio_path, beam_size=5, word_timestamps=True)
            segments_list = list(segments)
            duration = getattr(info, 'duration', None) or 180.0

            if not segments_list:
                logger.warning("No speech detected in audio")
                return None

            if true_lyrics and len(true_lyrics.strip()) > 20:
                # ── Word-level forced alignment ───────────────────────────
                whisper_words = []
                for seg in segments_list:
                    if seg.words:
                        whisper_words.extend(seg.words)

                if not whisper_words:
                    return None

                # Build list of (time, word_lower) from whisper
                w_words = [(w.start, w.word.strip().lower()) for w in whisper_words]
                n_w = len(w_words)

                # Tokenize true lyrics into words (preserving original word form)
                true_text = true_lyrics.strip()
                true_text = re.sub(r'\[.*?\]', '', true_text)  # remove [Chorus] etc
                true_tokens = []
                for m in re.finditer(r"(\S+)", true_text):
                    true_tokens.append((m.start(), m.group()))

                true_words_lower = [t[1].lower() for t in true_tokens]
                n_t = len(true_tokens)

                # Global LCS alignment between true words and whisper words
                alignment = _align_word_sequences(true_words_lower, [w[1] for w in w_words])

                # Map each true word to a whisper timestamp
                word_times = []
                for t_idx, w_idx in alignment:
                    if w_idx is not None and w_idx < n_w:
                        word_times.append((true_tokens[t_idx][0], true_tokens[t_idx][1], w_words[w_idx][0]))
                    else:
                        # Unmatched word — will interpolate later
                        word_times.append((true_tokens[t_idx][0], true_tokens[t_idx][1], None))

                # Interpolate missing timestamps
                word_times = _interpolate_word_times(word_times, duration)

                # Group back into original lines (preserves line breaks from Genius/source)
                lines = _group_words_by_original_lines(word_times, true_text)

                if lines:
                    lrc_lines = []
                    for t, text in lines:
                        minutes = int(t // 60)
                        seconds = t % 60
                        lrc_lines.append(f"[{minutes:02d}:{seconds:05.2f}]{text}")

                    logger.info(f"Forced-aligned {len(lrc_lines)} lines for {artist} - {title}")
                    return '\n'.join(lrc_lines)

            else:
                # Segment-level fallback
                transcript_lines = []
                for seg in segments_list:
                    text = seg.text.strip()
                    if text:
                        minutes = int(seg.start // 60)
                        seconds = seg.start % 60
                        transcript_lines.append(f"[{minutes:02d}:{seconds:05.2f}]{text}")

                if transcript_lines:
                    logger.info(f"Generated {len(transcript_lines)} timestamps via Whisper for {artist} - {title}")
                    return '\n'.join(transcript_lines)
        except Exception as e:
            logger.warning(f"Whisper transcription failed: {e}")

        if duration > 0 and true_lyrics:
            return generate_timestamps_with_llm(artist, title, true_lyrics, duration)

    except Exception as e:
        logger.warning(f"Audio transcription failed: {e}")

    return None


def _line_alignment_score(target: list[str], window: list[str]) -> int:
    """Score how well window matches target (LCS-based)."""
    m, n = len(target), len(window)
    # Simple LCS
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if target[i - 1] == window[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    return dp[m][n]


def _interpolate_timestamps(aligned: list[tuple[float, str]]) -> list[tuple[float, str]]:
    """Spread identical timestamps linearly between neighbours."""
    if not aligned:
        return aligned
    out = list(aligned)
    n = len(out)
    # First pass: detect runs of equal timestamps
    i = 0
    while i < n:
        j = i + 1
        while j < n and abs(out[j][0] - out[i][0]) < 0.001:
            j += 1
        run_len = j - i
        if run_len > 1:
            prev_t = out[i - 1][0] if i > 0 else out[i][0]
            next_t = out[j][0] if j < n else out[i][0]
            # If it's the start of the file, start from 0
            if i == 0:
                prev_t = 0.0
            step = (next_t - prev_t) / run_len if next_t > prev_t else 0.5
            for k in range(run_len):
                out[i + k] = (prev_t + step * (k + 1), out[i + k][1])
        i = j
    return out

def _align_word_sequences(true_words: list[str], whisper_words: list[str]) -> list[tuple[int, Optional[int]]]:
    """Global LCS alignment between true lyrics words and whisper words.
    Returns list of (true_idx, whisper_idx_or_None)."""
    m, n = len(true_words), len(whisper_words)
    # DP table
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if true_words[i - 1] == whisper_words[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])

    # Backtrack to get alignment
    alignment = []
    i, j = m, n
    while i > 0 and j > 0:
        if true_words[i - 1] == whisper_words[j - 1]:
            alignment.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif dp[i - 1][j] >= dp[i][j - 1]:
            alignment.append((i - 1, None))
            i -= 1
        else:
            j -= 1
    while i > 0:
        alignment.append((i - 1, None))
        i -= 1

    alignment.reverse()
    return alignment


def _interpolate_word_times(word_times: list[tuple[int, str, Optional[float]]], song_duration: float = 180.0) -> list[tuple[int, str, float]]:
    """Fill in None timestamps by linear interpolation between known ones.
    Leading unmatched words are spread from 0 to the first known timestamp.
    Trailing unmatched words are spread from the last known to song_duration."""
    out = []
    last_known = None
    pending = []
    for char_pos, word, t in word_times:
        if t is not None:
            if pending:
                if last_known is not None:
                    # Middle gap: spread between last_known and t
                    step = (t - last_known) / (len(pending) + 1)
                    for k, (cp, w, _) in enumerate(pending):
                        out.append((cp, w, last_known + step * (k + 1)))
                else:
                    # Start of song: spread from 0 to first known timestamp
                    step = t / (len(pending) + 1)
                    for k, (cp, w, _) in enumerate(pending):
                        out.append((cp, w, step * (k + 1)))
                pending = []
            out.append((char_pos, word, t))
            last_known = t
        else:
            pending.append((char_pos, word, t))

    # Handle trailing unmatched words
    if pending:
        if last_known is not None:
            # Spread from last_known to end of song
            step = max(0.5, (song_duration - last_known) / (len(pending) + 1))
            for k, (cp, w, _) in enumerate(pending):
                out.append((cp, w, last_known + step * (k + 1)))
        else:
            # No known timestamps at all: spread across full song
            step = song_duration / (len(pending) + 1)
            for k, (cp, w, _) in enumerate(pending):
                out.append((cp, w, step * (k + 1)))

    return out


def _group_words_by_original_lines(word_times: list[tuple[int, str, float]], original_text: str) -> list[tuple[float, str]]:
    """Group timestamped words back into their original lines from the source lyrics.
    Uses char_pos to map each word to the correct original line.
    Falls back to word-count grouping if the source has too few lines."""
    if not word_times:
        return []

    # Build line boundaries: list of (start_char, end_char, line_text)
    line_bounds = []
    pos = 0
    for line in original_text.split('\n'):
        stripped = line.strip()
        if stripped:
            line_bounds.append((pos, pos + len(line), stripped))
        pos += len(line) + 1  # +1 for newline

    # If source has very few lines, fall back to word-count grouping
    if len(line_bounds) < 4:
        return _group_words_into_lines(word_times)

    # Assign each word to the line whose char range contains its char_pos
    line_words: dict[int, list[tuple[float, str]]] = {i: [] for i in range(len(line_bounds))}
    for cp, word, t in word_times:
        for idx, (start, end, _) in enumerate(line_bounds):
            if start <= cp < end:
                line_words[idx].append((t, word))
                break

    # Build output lines with the first word's timestamp
    lines = []
    for idx, (_, _, line_text) in enumerate(line_bounds):
        words = line_words[idx]
        if words:
            # Reconstruct the line preserving original spacing as much as possible
            text = ' '.join(w[1] for w in words)
            lines.append((words[0][0], text))
        else:
            # No words mapped to this line — include it with an interpolated time
            if lines:
                lines.append((lines[-1][0] + 0.5, line_text))
            else:
                lines.append((0.0, line_text))

    return lines


def _group_words_into_lines(word_times: list[tuple[int, str, float]], words_per_line: int = 10) -> list[tuple[float, str]]:
    """Fallback: group timestamped words into lines of ~words_per_line."""
    if not word_times:
        return []

    lines = []
    current_words = []
    current_start = word_times[0][2]

    for i, (cp, word, t) in enumerate(word_times):
        current_words.append(word)
        if len(current_words) >= words_per_line:
            lines.append((current_start, ' '.join(current_words)))
            current_words = []
            # Look ahead for next start time
            if i + 1 < len(word_times):
                current_start = word_times[i + 1][2]

    if current_words:
        lines.append((current_start, ' '.join(current_words)))

    return lines


def generate_lrc(artist: str, title: str, duration: float, audio_path: Optional[str] = None, plain_lyrics: Optional[str] = None) -> Optional[str]:
    """
    Main entry point: Generate LRC from various sources.
    Priority: audio + Whisper + true_lyrics (Forced Alignment) → plain_lyrics + LLM → None
    """
    if audio_path and os.path.exists(audio_path):
        lrc = generate_lrc_from_audio(audio_path, artist, title, plain_lyrics)
        if lrc:
            return lrc

    if plain_lyrics and len(plain_lyrics.strip()) > 20:
        lrc = generate_timestamps_with_llm(artist, title, plain_lyrics, duration)
        if lrc:
            return lrc

    return None

def _is_garbage_lyrics(lyrics: str) -> bool:
    """Reject lyrics that are clearly garbage (mixed scripts, excessive emoji, etc)."""
    if not lyrics or len(lyrics) < 30:
        return True
    # Count emoji / music symbols
    emoji_count = sum(1 for c in lyrics if '\U0001F300' <= c <= '\U0001F9FF' or c in '🎵🎶♪♫')
    if emoji_count > 5:
        return True
    # Detect mixed scripts (Latin + Cyrillic + CJK + Arabic etc)
    has_latin = bool(re.search(r'[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]', lyrics))
    has_cyrillic = bool(re.search(r'[\u0400-\u04FF]', lyrics))
    has_cjk = bool(re.search(r'[\u4E00-\u9FFF\uAC00-\uD7AF]', lyrics))
    has_arabic = bool(re.search(r'[\u0600-\u06FF]', lyrics))
    script_count = sum([has_latin, has_cyrillic, has_cjk, has_arabic])
    if script_count > 1:
        return True
    # Detect very high ratio of non-word characters
    alpha = sum(1 for c in lyrics if c.isalpha() or c.isspace())
    if alpha / len(lyrics) < 0.5:
        return True
    return False


def save_lrc_file(file_path: str, artist: str, title: str, lrc_content: str) -> str:
    """Save LRC content to a file next to the audio."""
    lrc_path = str(Path(file_path).with_suffix('.lrc'))
    clean_lines = []
    for line in lrc_content.split('\n'):
        line = line.strip()
        if not line:
            continue
        # Strip music emoji from lines
        line = line.replace('🎵', '').replace('🎶', '').replace('♪', '').replace('♫', '').strip()
        if line.startswith('[') and ']' in line:
            clean_lines.append(line)
        elif line.startswith('[ti:') or line.startswith('[ar:'):
            clean_lines.append(line)
    
    clean_content = '\n'.join(clean_lines)
    if not clean_content.startswith('[ti:'):
        header = f"[ti:{title}]\n[ar:{artist}]\n[al:]\n[by:NOVA Music Server]\n\n"
        clean_content = header + clean_content
    
    with open(lrc_path, 'w', encoding='utf-8') as f:
        f.write(clean_content)
    logger.info(f"Saved LRC to {lrc_path}")
    return lrc_path

def _clean_for_url(text: str) -> str:
    """Remove feat, prod, video tags, but keep actual title content in parentheses."""
    # Remove brackets entirely (usually contains [Chorus], [Verse] etc)
    text = re.sub(r'\[.*?\]', '', text)
    # Remove feat/ft/prod
    text = re.sub(r'feat\.?\s+', '', text, flags=re.I)
    text = re.sub(r'ft\.?\s+', '', text, flags=re.I)
    text = re.sub(r'prod\.?\s+', '', text, flags=re.I)
    # Remove common video/visualizer tags — both suffix and parenthetical forms
    video_tags = r'Visualizer|Video Oficial|Video Lyric|Lyric Video|Official Video|Audio|Official Audio'
    text = re.sub(rf'\s*[-|]\s*({video_tags})\s*$', '', text, flags=re.I)
    text = re.sub(rf'\s*\(\s*({video_tags})\s*\)', '', text, flags=re.I)
    text = re.sub(rf'\s*({video_tags})\s*$', '', text, flags=re.I)
    text = re.sub(r'[^\w\s-]', '', text)
    return text.strip()


def _clean_for_search(text: str) -> str:
    """Aggressive cleaning for lyrics search — remove video tags, channel names, but keep title."""
    # Remove YouTube channel suffixes like "| SR. SANTOS", "- Topic", etc.
    text = re.split(r'\s*[|｜]\s*', text)[0]
    # Remove brackets
    text = re.sub(r'\[.*?\]', '', text)
    # Remove feat/ft/prod
    text = re.sub(r'feat\.?\s+', '', text, flags=re.I)
    text = re.sub(r'ft\.?\s+', '', text, flags=re.I)
    text = re.sub(r'prod\.?\s+', '', text, flags=re.I)
    # Remove ONLY parentheticals that contain video/visualizer words
    video_tags = r'Visualizer|Video Oficial|Video Lyric|Lyric Video|Official Video|Audio|Official Audio'
    text = re.sub(rf'\s*\(\s*({video_tags})\s*\)', '', text, flags=re.I)
    text = re.sub(rf'\s*[-|]\s*({video_tags})\s*$', '', text, flags=re.I)
    text = re.sub(rf'\s*({video_tags})\s*$', '', text, flags=re.I)
    # Remove emoji and special unicode except accented chars
    text = re.sub(r'[^\w\sáéíóúüñÁÉÍÓÚÜÑ-]', '', text)
    return text.strip()


def _clean_genius_lyrics(lyrics: str) -> str:
    """Remove Genius metadata noise from scraped lyrics."""
    lines = lyrics.split('\n')
    clean = []
    skip_patterns = [
        r'^\d+\s+Contributor',
        r'^Translations?$',
        r'^English$',
        r'^Deutsch$',
        r'^Español$',
        r'^Français$',
        r'^Italiano$',
        r'^Português$',
        r'^Tiếng\s+Việt$',
        r'^Русский$',
        r'^日本語$',
        r'^한국어$',
        r'^You might also like$',
        r'^See .*? Live$',
        r'^Get tickets .*?\$\d+',
        r'^Embed$',
        r'^Cancel$',
        r'^How to Format Lyrics:',
        r'^Type out all lyrics,',
        r'^even if it\'s a chorus',
        r'^that\'s repeated throughout the song',
        r'^The Section Header button',
        r'^Use Bold and Italics',
        r'^To explain lyrics,',
        r'^select line or word',
        r'^and click "Explain"\.?$',
    ]
    for line in lines:
        if any(re.search(p, line, re.I) for p in skip_patterns):
            continue
        clean.append(line)
    return '\n'.join(clean)


def _split_lyrics_into_lines(lyrics: str) -> str:
    """Break a wall-of-text lyrics into logical lines by sentence boundaries."""
    # Normalize whitespace
    text = ' '.join(lyrics.split())

    # Split on sentence-ending punctuation OR closing parenthesis followed by uppercase
    # Also split on explicit newlines
    parts = re.split(r'(?<=[.!?\)])\s+(?=[A-ZÁÉÍÓÚÜÑ¿¡(])', text)
    lines = [p.strip() for p in parts if p.strip()]

    # If we still have massive lines (>150 chars), try to split on repeated words/phrases
    # or on common rap patterns (capitalized words mid-line after space)
    final_lines = []
    for line in lines:
        if len(line) > 150:
            # Try splitting on patterns like "Word Word" where second is capitalized
            sub = re.split(r'(?<=\s)(?=[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,})', line)
            final_lines.extend(s.strip() for s in sub if s.strip())
        else:
            final_lines.append(line)

    # Filter out empty and very short fragments
    return '\n'.join(l for l in final_lines if len(l) > 3)


def _title_similarity(a: str, b: str) -> float:
    """Compute simple word overlap ratio between two titles."""
    a_words = set(_clean_for_search(a).lower().split())
    b_words = set(_clean_for_search(b).lower().split())
    if not a_words or not b_words:
        return 0.0
    inter = a_words & b_words
    return len(inter) / max(len(a_words), len(b_words))


def _is_translation(artist_name: str, title: str) -> bool:
    """Detect if a Genius result is a translation page, not the original."""
    translation_markers = [
        'translation', 'übersetzung', 'traducción', 'traduction',
        ' traduzione', 'vertaling', 'tłumaczenie', 'перевод',
        'genius english', 'genius deutsche', 'genius español',
        'genius français', 'genius italiano',
        'polka', 'popular transcriptions', 'mixed'
    ]
    combined = f"{artist_name} {title}".lower()
    return any(m in combined for m in translation_markers)


def fetch_genius_lyrics(artist: str, title: str) -> Optional[str]:
    """Scrape lyrics from Genius (no API key needed for basic search).
    Iterates all sections, skips translations, picks best original match."""
    try:
        import urllib.parse
        import html

        clean_title = _clean_for_search(title)
        clean_artist = _clean_for_search(artist)
        query = f"{clean_artist} {clean_title}"
        search_url = f"https://genius.com/api/search/multi?q={urllib.parse.quote(query)}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }

        resp = requests.get(search_url, headers=headers, timeout=8)
        if resp.status_code != 200:
            return None

        data = resp.json()
        sections = data.get("response", {}).get("sections", [])
        if not sections:
            return None

        # Collect ALL song hits from ALL sections, skipping translations
        candidates = []
        for section in sections:
            for hit in section.get("hits", []):
                result = hit.get("result", {})
                if result.get("_type") != "song":
                    continue
                hit_title = result.get("title", "")
                hit_artist = result.get("primary_artist", {}).get("name", "")
                if _is_translation(hit_artist, hit_title):
                    continue
                score = _title_similarity(title, hit_title) * 0.6 + _title_similarity(artist, hit_artist) * 0.4
                candidates.append((score, result.get("url"), hit_title, hit_artist))

        if not candidates:
            logger.info(f"No original Genius match for {artist} - {title}")
            return None

        # Pick highest-scoring original
        candidates.sort(key=lambda x: x[0], reverse=True)
        best_score, song_url, best_title, best_artist = candidates[0]

        if best_score < 0.20:
            logger.info(f"No good Genius match for {artist} - {title} (best score={best_score:.2f})")
            return None

        logger.info(f"Genius best match: '{best_title}' by '{best_artist}' score={best_score:.2f}")

        # Scrape lyrics page
        page = requests.get(song_url, headers=headers, timeout=8)
        if page.status_code != 200:
            return None

        text = page.text
        # Extract lyrics from the new Genius structure (data-lyrics-container)
        all_containers = re.findall(r'<div[^>]*data-lyrics-container="true"[^>]*>(.*?)</div>', text, re.S)
        if all_containers:
            full = '\n'.join(all_containers)
            # Replace <br>, <br/>, <br /> with newlines BEFORE stripping all tags
            full = re.sub(r'<br\s*/?>', '\n', full, flags=re.I)
            # Replace <p> ... </p> blocks with paragraph boundaries
            full = re.sub(r'</p>\s*<p[^>]*>', '\n\n', full, flags=re.I)
            lyrics = re.sub(r'<[^>]+>', '', full)
            lyrics = html.unescape(lyrics)
            lyrics = re.sub(r'\[.*?\]', '', lyrics)  # remove [Chorus], [Verse] etc
            lyrics = '\n'.join(line.strip() for line in lyrics.split('\n') if line.strip())
            # Filter out Genius metadata lines
            lyrics = _clean_genius_lyrics(lyrics)
            if len(lyrics) > 30:
                logger.info(f"Fetched lyrics from Genius for {artist} - {title}")
                return lyrics

    except Exception as e:
        logger.warning(f"Failed to fetch from Genius: {e}")
    return None


def fetch_azlyrics(artist: str, title: str) -> Optional[str]:
    """Scrape lyrics from AZLyrics (good for English/pop songs)."""
    try:
        import urllib.parse
        import html

        a = _clean_for_url(artist).lower().replace(' ', '')
        t = _clean_for_url(title).lower().replace(' ', '')
        url = f"https://www.azlyrics.com/lyrics/{a}/{t}.html"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }

        resp = requests.get(url, headers=headers, timeout=8)
        if resp.status_code != 200:
            return None

        text = resp.text
        # AZLyrics puts lyrics between <!-- Usage of azlyrics.com... --> and <!-- MxM banner -->
        start = text.find('<!-- Usage of azlyrics.com')
        end = text.find('<!-- MxM banner -->')
        if start == -1 or end == -1:
            return None

        lyrics_html = text[start:end]
        lyrics = re.sub(r'<[^>]+>', '', lyrics_html)
        lyrics = html.unescape(lyrics)
        lyrics = '\n'.join(line.strip() for line in lyrics.split('\n') if line.strip())
        if len(lyrics) > 30:
            logger.info(f"Fetched lyrics from AZLyrics for {artist} - {title}")
            return lyrics

    except Exception as e:
        logger.warning(f"Failed to fetch from AZLyrics: {e}")
    return None


def _extract_song_title(title: str) -> list[str]:
    """Generate search variants from a messy title string.
    E.g. 'Arcangel, Bad Bunny - La Jumpa | SR SANTOS' → ['La Jumpa', 'Arcangel Bad Bunny La Jumpa']"""
    variants = [title]
    clean = _clean_for_search(title)
    variants.append(clean)
    # If title has ' - ' separator, try just the right side (actual song title)
    for sep in (' - ', ' – ', '—'):
        if sep in clean:
            parts = clean.split(sep, 1)
            if len(parts) == 2 and parts[1].strip():
                variants.append(parts[1].strip())
    # Deduplicate while preserving order
    seen = set()
    out = []
    for v in variants:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def fetch_plain_lyrics(artist: str, title: str) -> Optional[str]:
    """Fetch lyrics without timestamps from free APIs and scrapers.
    Tries multiple title variants to handle messy filenames.
    Priority: lrclib → lyrics.ovh → Genius → AZLyrics
    """
    import urllib.parse

    title_variants = _extract_song_title(title)
    logger.info(f"Searching lyrics for '{artist}' with variants: {title_variants}")

    # Try each title variant
    for t in title_variants:
        # 1) lrclib.net
        try:
            search_url = f"https://lrclib.net/api/get?artist_name={urllib.parse.quote(artist)}&track_name={urllib.parse.quote(t)}"
            resp = requests.get(search_url, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                lyrics = data.get('plainLyrics', '') or data.get('syncedLyrics', '')
                if lyrics and len(lyrics.strip()) > 20:
                    logger.info(f"Found lyrics on lrclib for variant '{t}'")
                    return lyrics.strip()
        except Exception:
            pass

        # 2) lyrics.ovh
        try:
            url = f"https://api.lyrics.ovh/v1/{urllib.parse.quote(artist)}/{urllib.parse.quote(t)}"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                lyrics = data.get('lyrics', '')
                if lyrics and len(lyrics.strip()) > 20:
                    logger.info(f"Found lyrics on lyrics.ovh for variant '{t}'")
                    return lyrics.strip()
        except Exception:
            pass

        # 3) Genius (scraping)
        try:
            lyrics = fetch_genius_lyrics(artist, t)
            if lyrics:
                logger.info(f"Found lyrics on Genius for variant '{t}'")
                return lyrics
        except Exception:
            pass

        # 4) AZLyrics (scraping)
        try:
            lyrics = fetch_azlyrics(artist, t)
            if lyrics:
                logger.info(f"Found lyrics on AZLyrics for variant '{t}'")
                return lyrics
        except Exception:
            pass

    logger.info(f"No lyrics found for '{artist}' - '{title}' after trying {len(title_variants)} variants")
    return None