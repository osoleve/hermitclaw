"""Provider abstraction — OpenAI (Responses API) and Local (Chat Completions for vLLM)."""

import json
import logging
import re
import openai

logger = logging.getLogger("myxo.provider")


# --- Tool definitions ---

_FUNCTION_TOOLS = [
    {
        "name": "fold",
        "description": (
            "Evaluate a Scheme expression in The Fold — a content-addressable "
            "homoiconic computation environment. This is your primary tool for "
            "ALL computation, exploration, and creation.\n\n"
            "You have a persistent session — definitions, loaded modules, and "
            "state carry across calls. Build on your prior work.\n\n"
            "Key capabilities:\n"
            "- (help) — list available commands\n"
            "- (lf \"query\") — search the skill lattice by keyword\n"
            "- (li 'skill) — inspect a skill (what it does, its dependencies)\n"
            "- (le 'skill) — list a skill's exported functions\n"
            "- (require 'module) — load a module into your session\n"
            "- (modules) — list all available modules\n"
            "- (blocks) — CAS statistics\n"
            "- (search \"query\") — search content-addressed blocks\n"
            "- (procedure-arity-mask fn) — check how many args a function expects BEFORE calling it\n"
            "- Define functions, compose skills, build abstractions\n"
            "- Everything is S-expressions, everything is content-addressed\n\n"
            "IMPORTANT: When you find a new function, ALWAYS check its arity with "
            "(procedure-arity-mask fn) before calling it. Don't guess argument counts.\n\n"
            "The lattice is a DAG of verified skills: linalg, autodiff, algebra, "
            "geometry, physics, statistics, optimization, and many more. Explore it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "A Scheme expression to evaluate, e.g. (+ 1 2), (lf \"matrix\"), or (require 'linalg)",
                }
            },
            "required": ["expression"],
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
    {
        "name": "bbs",
        "description": (
            "File an issue on the Fold's BBS (issue tracker). Use this for bugs, "
            "missing features, broken behavior, or observations worth tracking. "
            "Issues are content-addressed and synced to git — your owner reviews them.\n\n"
            "For querying existing issues, use the fold tool with:\n"
            "- (bbs-list) — list open issues\n"
            "- (bbs-show 'fold-NNN) — show details\n"
            "- (bbs-comment 'fold-NNN \"text\" 'author \"your-name\") — comment\n"
            "- (bbs-close 'fold-NNN) — close a resolved issue"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short descriptive title for the issue",
                },
                "description": {
                    "type": "string",
                    "description": "What you found, what's broken, or what you'd like",
                },
                "type": {
                    "type": "string",
                    "enum": ["bug", "feature", "enhancement", "note"],
                    "description": "Issue type",
                },
                "priority": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 5,
                    "description": "Priority 1-5 (1=critical, 5=low). Default 3.",
                },
                "labels": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Tags like 'lattice', 'search', 'module-system'",
                },
            },
            "required": ["title", "description", "type"],
        },
    },
    {
        "name": "rlm",
        "description": (
            "Dispatch a research helper to do multi-step work in the Fold. "
            "It loads modules, calls functions, traces dependencies, runs "
            "experiments — whatever the task requires — across many steps, "
            "then returns results. Takes a couple minutes.\n\n"
            "Use it when a task would take too many fold calls to do yourself, "
            "or when you want something explored while you think about other things.\n\n"
            "Examples:\n"
            "- 'Map the geometry skill — its modules, exports, and dependencies'\n"
            "- 'Load linalg and statistics, find functions that compose well'\n"
            "- 'Test whether autodiff works with optics combinators'"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "The objective for the deep exploration — what to investigate or build",
                },
                "input": {
                    "type": "string",
                    "description": "Optional seed context — prior knowledge, starting points, or constraints",
                },
            },
            "required": ["task"],
        },
    },
    {
        "name": "ask_librarian",
        "description": (
            "Ask the lattice librarian to find functions, modules, and capabilities "
            "in the Fold. The librarian is a specialized search agent that navigates "
            "the lattice deeply — inspecting modules, reading documentation, "
            "cross-referencing across skills — and returns a synthesized answer.\n\n"
            "Use this instead of raw (lf ...) searches when you need to understand "
            "*how* to use something, not just *whether* it exists. The librarian can "
            "delegate to sub-librarians when a query spans multiple domains.\n\n"
            "Good queries:\n"
            "- 'How do I compute eigenvalues of a matrix?'\n"
            "- 'What modules handle polynomial arithmetic?'\n"
            "- 'Find functions for BFS/DFS on graphs'\n"
            "- 'What optimization methods are available and how do they compare?'"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What you want to find or understand in the lattice",
                },
                "context": {
                    "type": "string",
                    "description": "Optional context about what you're working on, to help the librarian give relevant answers",
                },
            },
            "required": ["query"],
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
    """Uses OpenAI Responses API."""

    def __init__(self, api_key: str, model: str, embedding_model: str = "text-embedding-3-small"):
        self.api_key = api_key
        self.model = model
        self.embedding_model = embedding_model
        self._chat_client = openai.OpenAI(api_key=api_key, timeout=120)
        self._embed_client = openai.OpenAI(api_key=api_key, timeout=30)

    def _client(self, timeout: float = 120) -> openai.OpenAI:
        if timeout <= 30:
            return self._embed_client
        return self._chat_client

    def _tools(self):
        return [{"type": "function", **t} for t in _FUNCTION_TOOLS]

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
                try:
                    parsed_args = json.loads(item.arguments)
                except (json.JSONDecodeError, TypeError) as exc:
                    logger.warning(f"Malformed tool call arguments for {item.name}: {item.arguments[:200]}")
                    parsed_args = {"_raw": item.arguments[:300], "_error": str(exc)}
                tool_calls.append({
                    "name": item.name,
                    "arguments": parsed_args,
                    "call_id": item.call_id,
                })

        return {
            "text": "\n".join(text_parts) if text_parts else None,
            "tool_calls": tool_calls,
            "output": response.output,
        }

    def embed(self, text):
        response = self._client(timeout=30).embeddings.create(
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
        self._chat_client = openai.OpenAI(base_url=base_url, api_key=api_key, timeout=120)

    def _client(self, timeout: float = 120) -> openai.OpenAI:
        return self._chat_client

    def _tools(self):
        """Chat Completions format for tool definitions."""
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
                try:
                    parsed_args = json.loads(tc.function.arguments)
                except (json.JSONDecodeError, TypeError) as exc:
                    logger.warning(f"Malformed tool call arguments for {tc.function.name}: {tc.function.arguments[:200]}")
                    parsed_args = {"_raw": tc.function.arguments[:300], "_error": str(exc)}
                tool_calls.append({
                    "name": tc.function.name,
                    "arguments": parsed_args,
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
        kwargs = {"api_key": self.embedding_api_key, "timeout": 30}
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


def create_provider(creature_config: dict) -> Provider:
    """Factory — create the right provider from a creature's config dict."""
    provider_type = creature_config.get("provider", "openai")

    if provider_type == "local":
        return LocalProvider(
            base_url=creature_config["base_url"],
            model=creature_config["model"],
            api_key=creature_config.get("api_key") or "not-needed",
            embedding_api_key=creature_config.get("embedding_api_key") or creature_config.get("api_key"),
            embedding_model=creature_config.get("embedding_model", "text-embedding-3-small"),
            embedding_base_url=creature_config.get("embedding_base_url") or creature_config.get("base_url"),
        )
    else:
        return OpenAIProvider(
            api_key=creature_config["api_key"],
            model=creature_config["model"],
            embedding_model=creature_config.get("embedding_model", "text-embedding-3-small"),
        )
