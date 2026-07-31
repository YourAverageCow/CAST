import os
from abc import ABC, abstractmethod
from enum import Enum

from dotenv import load_dotenv
import httpx

from prompts import STORY_SYSTEM, STORY_USER, IDEAS_PROMPT, build_story_system

# Load .env from the project root at import time so env vars are available
# everywhere the module is imported.
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# Resolves from the DEEPSEEK_API_KEY environment variable (or .env file).
# Keep as placeholder only — never hardcode a real key in source.
DEFAULT_DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")


class Provider(Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OPENROUTER = "openrouter"
    DEEPSEEK = "deepseek"


MODELS = {
    Provider.OPENAI: [
        {"id": "gpt-4o", "name": "GPT-4o"},
        {"id": "gpt-4o-mini", "name": "GPT-4o Mini"},
    ],
    Provider.ANTHROPIC: [
        {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4"},
        {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet"},
        {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku"},
    ],
    Provider.OPENROUTER: [
        {"id": "openai/gpt-4o", "name": "GPT-4o"},
        {"id": "anthropic/claude-sonnet-4-20250514", "name": "Claude Sonnet 4"},
        {"id": "meta-llama/llama-3.1-405b-instruct", "name": "Llama 3.1 405B"},
        {"id": "deepseek/deepseek-chat", "name": "DeepSeek V3"},
    ],
    Provider.DEEPSEEK: [
        {"id": "deepseek-chat", "name": "DeepSeek V3"},
        {"id": "deepseek-reasoner", "name": "DeepSeek R1"},
    ],
}


class LLMProvider(ABC):
    def __init__(self, api_key: str, model: str):
        self.api_key = api_key
        self.model = model

    @abstractmethod
    async def generate(self, system: str, user: str, temperature: float = 0.9) -> str: ...

    @abstractmethod
    async def stream(self, system: str, user: str, temperature: float = 0.9):
        yield ""


class OpenAIProvider(LLMProvider):
    async def generate(self, system: str, user: str, temperature: float = 0.9) -> str:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=self.api_key)
        resp = await client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content or ""

    async def stream(self, system: str, user: str, temperature: float = 0.9):
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=self.api_key)
        s = await client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            stream=True,
        )
        async for chunk in s:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


class AnthropicProvider(LLMProvider):
    async def generate(self, system: str, user: str, temperature: float = 0.9) -> str:
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        resp = await client.messages.create(
            model=self.model,
            max_tokens=2048,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return resp.content[0].text

    async def stream(self, system: str, user: str, temperature: float = 0.9):
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        async with client.messages.stream(
            model=self.model,
            max_tokens=2048,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": user}],
        ) as s:
            async for text in s.text_stream:
                yield text


class OpenRouterProvider(LLMProvider):
    async def generate(self, system: str, user: str, temperature: float = 0.9) -> str:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "HTTP-Referer": "http://localhost:8000",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "temperature": temperature,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    async def stream(self, system: str, user: str, temperature: float = 0.9):
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=self.api_key,
            base_url="https://openrouter.ai/api/v1",
        )
        s = await client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            extra_headers={"HTTP-Referer": "http://localhost:8000"},
            stream=True,
        )
        async for chunk in s:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


class DeepSeekProvider(LLMProvider):
    async def generate(self, system: str, user: str, temperature: float = 0.9) -> str:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(
            api_key=self.api_key,
            base_url="https://api.deepseek.com/v1",
        )
        resp = await client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content or ""

    async def stream(self, system: str, user: str, temperature: float = 0.9):
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=self.api_key, base_url="https://api.deepseek.com/v1")
        s = await client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            stream=True,
        )
        async for chunk in s:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


def get_provider(provider: Provider, api_key: str, model: str) -> LLMProvider:
    match provider:
        case Provider.OPENAI:
            return OpenAIProvider(api_key, model)
        case Provider.ANTHROPIC:
            return AnthropicProvider(api_key, model)
        case Provider.OPENROUTER:
            return OpenRouterProvider(api_key, model)
        case Provider.DEEPSEEK:
            return DeepSeekProvider(api_key, model)
