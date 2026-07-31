"""Loader for the plain-text prompt file.

Edit prompts.txt — the section headers ([IDEAS_PROMPT], [STORY_SYSTEM], etc.)
are used as keys. This module reads them at import time.
"""

import os
import re

_PROMPTS_PATH = os.path.join(os.path.dirname(__file__), "prompts.txt")


def _load_prompts(path: str) -> dict:
    prompts = {}
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # Split into sections by [SECTION_NAME] headers
    parts = re.split(r"^\[(\w+)\]\s*$", content, flags=re.MULTILINE)
    # parts[0] is any text before the first header
    for i in range(1, len(parts), 2):
        name = parts[i].strip()
        body = parts[i + 1].strip()
        prompts[name] = body

    return prompts


def _load():
    if not os.path.exists(_PROMPTS_PATH):
        raise FileNotFoundError(
            f"prompts.txt not found at {_PROMPTS_PATH}"
        )
    return _load_prompts(_PROMPTS_PATH)


_PROMPTS = _load()

IDEAS_PROMPT = _PROMPTS["IDEAS_PROMPT"]
IDEAS_SYSTEM = _PROMPTS["IDEAS_SYSTEM"]
STORY_SYSTEM = _PROMPTS["STORY_SYSTEM"]
STORY_USER = _PROMPTS["STORY_USER"]


def build_story_system(word_count: int = 400) -> str:
    """Build the story system prompt with the requested word count filled in."""
    return STORY_SYSTEM.format(word_count=word_count)
