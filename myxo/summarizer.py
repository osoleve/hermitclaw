"""Lightweight result summarizer using a local small model."""

import logging
import openai

logger = logging.getLogger("myxo.summarizer")

# Results shorter than this go through unchanged
SUMMARIZE_THRESHOLD = 300

_client = None
_model = None


def init(base_url: str, model: str):
    """Initialize the summarizer with a local vLLM endpoint."""
    global _client, _model
    _client = openai.OpenAI(base_url=base_url, api_key="not-needed", timeout=15)
    _model = model
    logger.info(f"Summarizer ready: {model} at {base_url}")


def summarize_result(expression: str, result: str,
                     context: list[str] | None = None) -> str:
    """Summarize a heavy Fold result. Returns original if short or summarizer unavailable.

    context: optional list of recent assistant messages (creature's thoughts)
             so the summarizer can prioritize what's relevant.
    """
    if _client is None or len(result) <= SUMMARIZE_THRESHOLD:
        return result

    # Don't summarize errors
    if result.startswith("Error:"):
        return result

    # Build system prompt with optional context
    sys_prompt = (
        "You compress verbose REPL output into a short, direct summary. "
        "Write as if you ARE the condensed result — not a description of it. "
        "Never say 'The REPL evaluated' or 'The result shows'. "
        "Just give the essential content: names, values, structure. "
        "Use terse notation. 2-4 lines max."
    )
    if context:
        thread = "; ".join(t[:100] for t in context[-3:])
        sys_prompt += f"\nThe user's current thread: {thread}"

    try:
        response = _client.chat.completions.create(
            model=_model,
            messages=[{
                "role": "system",
                "content": sys_prompt,
            }, {
                "role": "user",
                "content": (
                    f"> {expression}\n\n"
                    f"{result[:3000]}"
                ),
            }],
            max_tokens=200,
        )
        summary = response.choices[0].message.content.strip()
        if summary:
            return f"{summary}\n({len(result)} chars total)"
        return result
    except Exception as e:
        logger.warning(f"Summarizer failed, using raw result: {e}")
        return result
