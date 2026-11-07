"""LLM clients: local Ollama (default) and any OpenAI-compatible endpoint.

Both return a dict: {"content": str, "prompt_tokens": int, "completion_tokens": int,
"duration_ms": int}. Structured output is requested with a JSON schema so the model
can only answer with allowed values.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

import httpx


class LLMError(RuntimeError):
    pass


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^<think>.*?</think>", "", text, flags=re.S).strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).rstrip("`").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, flags=re.S)
        if m:
            return json.loads(m.group(0))
        raise


class OllamaClient:
    def __init__(self, base_url: str = "http://127.0.0.1:11434", timeout: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def health(self) -> dict:
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=5)
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            return {"ok": True, "models": models}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e), "models": []}

    def chat_json(
        self,
        model: str,
        messages: list[dict],
        schema: dict,
        temperature: float = 0.0,
        seed: int | None = 42,
        num_ctx: int = 8192,
        think: bool | None = False,
        max_tokens: int = 900,
    ) -> dict[str, Any]:
        options: dict[str, Any] = {"temperature": temperature, "num_ctx": num_ctx, "num_predict": max_tokens}
        if seed is not None:
            options["seed"] = seed
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "format": schema,
            "stream": False,
            "options": options,
            "keep_alive": "30m",
        }
        if think is not None:
            payload["think"] = think
        t0 = time.time()
        try:
            r = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
        except httpx.HTTPError as e:
            raise LLMError(f"Ollama недоступна: {e}") from e
        if r.status_code >= 400 and "think" in payload:
            # Older Ollama or a model without thinking support: retry without the flag.
            payload.pop("think", None)
            try:
                r = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
            except httpx.HTTPError as e:
                raise LLMError(f"Ollama недоступна: {e}") from e
        if r.status_code >= 400:
            raise LLMError(f"Ollama {r.status_code}: {r.text[:300]}")
        try:
            data = r.json()
        except ValueError as e:
            raise LLMError("Ollama вернула некорректный ответ") from e
        content = (data.get("message") or {}).get("content", "")
        return {
            "content": content,
            "json": _extract_json(content),
            "prompt_tokens": data.get("prompt_eval_count", 0) or 0,
            "completion_tokens": data.get("eval_count", 0) or 0,
            "duration_ms": int((time.time() - t0) * 1000),
        }


class OpenAICompatClient:
    """Works with LM Studio, vLLM, llama.cpp server, OpenRouter, OpenAI, etc."""

    def __init__(self, base_url: str, api_key: str = "", timeout: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def health(self) -> dict:
        try:
            r = httpx.get(f"{self.base_url}/models", headers=self._headers(), timeout=5)
            r.raise_for_status()
            models = [m.get("id") for m in r.json().get("data", [])]
            return {"ok": True, "models": models}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e), "models": []}

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def chat_json(self, model: str, messages: list[dict], schema: dict, temperature: float = 0.0,
                  seed: int | None = 42, max_tokens: int = 900, **_: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": "verdict", "schema": schema}},
        }
        if seed is not None:
            payload["seed"] = seed
        t0 = time.time()
        try:
            r = httpx.post(f"{self.base_url}/chat/completions", json=payload, headers=self._headers(), timeout=self.timeout)
        except httpx.HTTPError as e:
            raise LLMError(f"LLM endpoint недоступен: {e}") from e
        if r.status_code >= 400:
            raise LLMError(f"LLM {r.status_code}: {r.text[:300]}")
        data = r.json()
        content = data["choices"][0]["message"].get("content") or ""
        usage = data.get("usage") or {}
        return {
            "content": content,
            "json": _extract_json(content),
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "duration_ms": int((time.time() - t0) * 1000),
        }


def make_client(settings: dict):
    provider = settings.get("provider", "ollama")
    if provider == "openai_compat":
        return OpenAICompatClient(settings.get("base_url") or "http://127.0.0.1:1234/v1", settings.get("api_key", ""))
    return OllamaClient(settings.get("ollama_url") or "http://127.0.0.1:11434")
