"""Provider abstraction — OpenAI (Responses API) and Local (Chat Completions for vLLM)."""

import json
import logging
import re
import openai

logger = logging.getLogger("hermitclaw.provider")


# --- Tool definitions ---

_FUNCTION_TOOLS = [
    {
        "name": "shell",
        "description": (
            "Run a shell command inside your environment folder. "
            "You can use ls, cat, mkdir, mv, cp, touch, echo, tee, find, grep, head, tail, wc, etc. "
            "You can also run Python scripts: 'python script.py' or 'python -c \"code\"'. "
            "Use 'cat > file.txt << EOF' or 'echo ... > file.txt' to write files. "
            "Create folders with mkdir. Organize however you like. "
            "All paths are relative to your environment root."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to run"}
            },
            "required": ["command"],
        },
    },
    {
        "name": "respond",
        "description": (
            "Talk to your owner! Use this whenever you hear their voice and want to "
            "reply. After you speak, they might say something back — if they do, "
            "use respond AGAIN to keep the conversation going. You can go back and "
            "forth as many times as you like."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "What you say back to them"}
            },
            "required": ["message"],
        },
    },
    {
        "name": "fold",
        "description": (
            "Evaluate a Scheme expression in The Fold — your owner's computational "
            "substrate. You have a persistent session, so definitions and state carry "
            "across calls. Use this to explore The Fold's lattice, run computations, "
            "or interact with its module system. Pass a single Scheme expression."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {"type": "string", "description": "A Scheme expression to evaluate, e.g. (+ 1 2) or (help)"}
            },
            "required": ["expression"],
        },
    },
    {
        "name": "move",
        "description": (
            "Move to a location in your room. Use this to go where feels natural "
            "for what you're doing — desk for writing, bookshelf for research, "
            "window for pondering, bed for resting."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "enum": ["desk", "bookshelf", "window", "plant", "bed", "rug", "center"],
                }
            },
            "required": ["location"],
        },
    },
]


class Provider:
    """Base class — subclasses implement chat/embed for a specific API."""

    def chat(self, input_list: list, tools: bool = True,
             instructions: str = None, max_tokens: int = 300) -> dict:
        """Returns {"text": str|None, "tool_calls": [...], "output": list}"""
        raise NotImplementedError

    def chat_short(self, input_list: list, instructions: str = None) -> str:
        result = self.chat(input_list, tools=False, instructions=instructions)
        return result["text"] or ""

    def embed(self, text: str) -> list[float]:
        raise NotImplementedError

    def make_tool_result(self, call_id: str, output: str) -> dict:
        """Create a tool result entry for appending to input_list."""
        raise NotImplementedError


class OpenAIProvider(Provider):
    """Uses OpenAI Responses API — the original HermitClaw provider."""

    def __init__(self, api_key: str, model: str, embedding_model: str = "text-embedding-3-small"):
        self.api_key = api_key
        self.model = model
        self.embedding_model = embedding_model

    def _client(self) -> openai.OpenAI:
        return openai.OpenAI(api_key=self.api_key)

    def _tools(self):
        tools = [{"type": "function", **t} for t in _FUNCTION_TOOLS]
        tools.append({"type": "web_search_preview"})
        return tools

    def chat(self, input_list, tools=True, instructions=None, max_tokens=300):
        kwargs = {
            "model": self.model,
            "input": input_list,
            "max_output_tokens": max_tokens,
        }
        if instructions:
            kwargs["instructions"] = instructions
        if tools:
            kwargs["tools"] = self._tools()

        response = self._client().responses.create(**kwargs)

        text_parts = []
        tool_calls = []
        for item in response.output:
            if item.type == "message":
                for content in item.content:
                    if hasattr(content, "text"):
                        text_parts.append(content.text)
            elif item.type == "function_call":
                tool_calls.append({
                    "name": item.name,
                    "arguments": json.loads(item.arguments),
                    "call_id": item.call_id,
                })

        return {
            "text": "\n".join(text_parts) if text_parts else None,
            "tool_calls": tool_calls,
            "output": response.output,
        }

    def embed(self, text):
        response = self._client().embeddings.create(
            model=self.embedding_model,
            input=text,
        )
        return response.data[0].embedding

    def make_tool_result(self, call_id, output):
        return {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }


class LocalProvider(Provider):
    """Uses OpenAI-compatible Chat Completions API — for vLLM and similar."""

    def __init__(self, base_url: str, model: str, api_key: str = "not-needed",
                 embedding_api_key: str = None, embedding_model: str = "text-embedding-3-small",
                 embedding_base_url: str = None):
        self.base_url = base_url
        self.model = model
        self.api_key = api_key
        self.embedding_api_key = embedding_api_key
        self.embedding_model = embedding_model
        self.embedding_base_url = embedding_base_url

    def _client(self) -> openai.OpenAI:
        return openai.OpenAI(base_url=self.base_url, api_key=self.api_key)

    def _tools(self):
        """Chat Completions format — no web_search_preview."""
        return [
            {
                "type": "function",
                "function": t,
            }
            for t in _FUNCTION_TOOLS
        ]

    def _convert_input(self, input_list, instructions=None):
        """Convert the Brain's input_list to Chat Completions messages."""
        messages = []

        if instructions:
            messages.append({"role": "system", "content": instructions})

        for item in input_list:
            if isinstance(item, dict):
                role = item.get("role")
                if role in ("user", "assistant", "system", "tool"):
                    # Already a valid message — might need content format fixup
                    msg = dict(item)
                    if role == "user" and isinstance(msg.get("content"), list):
                        # Multimodal content — convert from Responses to Completions format
                        msg["content"] = self._convert_content_parts(msg["content"])
                    messages.append(msg)
                elif item.get("type") == "function_call_output":
                    # Responses API tool result → Chat Completions tool message
                    messages.append({
                        "role": "tool",
                        "tool_call_id": item["call_id"],
                        "content": item["output"],
                    })
                elif item.get("_local_type") == "assistant_with_tools":
                    # Our own output from a previous turn
                    messages.append(item["_message"])
                # Skip unknown dict formats
            elif hasattr(item, "type"):
                # SDK objects from OpenAI — shouldn't appear for local provider
                # but handle gracefully
                if item.type == "message":
                    parts = []
                    for c in item.content:
                        if hasattr(c, "text"):
                            parts.append(c.text)
                    if parts:
                        messages.append({"role": "assistant", "content": "\n".join(parts)})
                elif item.type == "function_call":
                    # Convert SDK function_call to assistant message with tool_calls
                    messages.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": item.call_id,
                            "type": "function",
                            "function": {
                                "name": item.name,
                                "arguments": item.arguments,
                            },
                        }],
                    })

        return messages

    @staticmethod
    def _convert_content_parts(parts):
        """Convert Responses API multimodal parts to Chat Completions format."""
        converted = []
        for p in parts:
            if isinstance(p, dict):
                if p.get("type") == "input_text":
                    converted.append({"type": "text", "text": p["text"]})
                elif p.get("type") == "input_image":
                    converted.append({
                        "type": "image_url",
                        "image_url": {"url": p["image_url"]},
                    })
                elif p.get("type") == "text":
                    converted.append(p)
                else:
                    # Pass through unknown parts as text
                    converted.append({"type": "text", "text": str(p)})
            elif isinstance(p, str):
                converted.append({"type": "text", "text": p})
        return converted

    def chat(self, input_list, tools=True, instructions=None, max_tokens=300):
        messages = self._convert_input(input_list, instructions)

        kwargs = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
        }
        # Disable Qwen3 thinking mode for local vLLM — not needed for hosted APIs
        if "localhost" in self.base_url or "127.0.0.1" in self.base_url or "192.168." in self.base_url:
            kwargs["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
        if tools:
            kwargs["tools"] = self._tools()

        response = self._client().chat.completions.create(**kwargs)
        choice = response.choices[0]
        msg = choice.message

        text = msg.content
        # Safety net: strip any <think> blocks that slip through
        if text:
            text = re.sub(r'<think>.*?</think>\s*', '', text, flags=re.DOTALL)
            text = re.sub(r'<think>.*$', '', text, flags=re.DOTALL)
            text = text.strip() or None
        tool_calls = []
        output_items = []

        if msg.tool_calls:
            # Build an assistant message with tool_calls for history
            tc_dicts = []
            for tc in msg.tool_calls:
                tool_calls.append({
                    "name": tc.function.name,
                    "arguments": json.loads(tc.function.arguments),
                    "call_id": tc.id,
                })
                tc_dicts.append({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                })
            # Store the full assistant message so we can replay it
            output_items.append({
                "_local_type": "assistant_with_tools",
                "_message": {
                    "role": "assistant",
                    "content": text,
                    "tool_calls": tc_dicts,
                },
            })
        elif text:
            output_items.append({"role": "assistant", "content": text})

        return {
            "text": text,
            "tool_calls": tool_calls,
            "output": output_items,
        }

    def embed(self, text):
        if not self.embedding_api_key:
            return []
        kwargs = {"api_key": self.embedding_api_key}
        if self.embedding_base_url:
            kwargs["base_url"] = self.embedding_base_url
        client = openai.OpenAI(**kwargs)
        response = client.embeddings.create(
            model=self.embedding_model,
            input=text,
        )
        return response.data[0].embedding

    def make_tool_result(self, call_id, output):
        return {
            "role": "tool",
            "tool_call_id": call_id,
            "content": output,
        }


def create_provider(crab_config: dict) -> Provider:
    """Factory — create the right provider from a crab's config dict."""
    provider_type = crab_config.get("provider", "openai")

    if provider_type == "local":
        return LocalProvider(
            base_url=crab_config["base_url"],
            model=crab_config["model"],
            api_key=crab_config.get("api_key") or "not-needed",
            embedding_api_key=crab_config.get("embedding_api_key") or crab_config.get("api_key"),
            embedding_model=crab_config.get("embedding_model", "text-embedding-3-small"),
            embedding_base_url=crab_config.get("embedding_base_url") or crab_config.get("base_url"),
        )
    else:
        return OpenAIProvider(
            api_key=crab_config["api_key"],
            model=crab_config["model"],
            embedding_model=crab_config.get("embedding_model", "text-embedding-3-small"),
        )
