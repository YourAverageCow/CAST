import json
from providers import LLMProvider
from prompts import STORY_SYSTEM, STORY_USER, IDEAS_PROMPT, build_story_system


async def generate_ideas(provider: LLMProvider) -> list[str]:
    raw = await provider.generate(
        system="You generate creative writing prompts. Output only valid JSON array. No markdown.",
        user=IDEAS_PROMPT,
        temperature=1.0,
    )
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return [line.strip("- ").strip() for line in raw.split("\n") if line.strip() and len(line) > 5]


async def generate_story(provider: LLMProvider, premise: str, word_count: int = 400) -> str:
    story = await provider.generate(
        system=build_story_system(word_count),
        user=STORY_USER.format(premise=premise),
        temperature=0.9,
    )
    story = story.strip()
    if story.startswith("```"):
        lines = story.split("\n")
        story = "\n".join(lines[1:])
        if story.endswith("```"):
            story = story[:-3]
    return story.strip()


async def generate_batch(provider: LLMProvider, premise: str | None, count: int) -> list[str]:
    stories = []
    for _ in range(count):
        current_premise = premise
        if not current_premise:
            ideas = await generate_ideas(provider)
            current_premise = ideas[0] if ideas else "a fight over inheritance at a family dinner"
        story = await generate_story(provider, current_premise)
        stories.append(story)
    return stories
