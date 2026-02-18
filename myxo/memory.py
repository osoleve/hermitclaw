"""Smallville-inspired memory stream with three-factor retrieval."""

import json
import logging
import math
import os
import re
from datetime import datetime

from myxo.config import config
from myxo.prompts import IMPORTANCE_PROMPT

logger = logging.getLogger("myxo.memory")

STREAM_FILENAME = "memory_stream.jsonl"
STATE_FILENAME = "memory_state.json"

# Retrieval weights — relevance-dominant so semantic search matters more than age
W_RECENCY = 0.3
W_IMPORTANCE = 0.2
W_RELEVANCE = 0.5

# Reflections get this multiplier on their retrieval score to prevent pollution
REFLECTION_WEIGHT = 0.5


def _cosine_sim(a: list[float], b: list[float]) -> float:
    """Pure-Python cosine similarity — no numpy needed."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class MemoryStream:
    """Append-only memory stream with recency × importance × relevance retrieval."""

    def __init__(self, environment_path: str, provider=None):
        self.env_path = environment_path
        self.path = os.path.join(environment_path, STREAM_FILENAME)
        self._state_path = os.path.join(environment_path, STATE_FILENAME)
        self.provider = provider
        self.memories: list[dict] = []
        self.importance_sum: float = 0.0  # running sum since last reflection
        self._next_id: int = 0
        self._load()

    def _load(self):
        """Load existing memories from JSONL on startup."""
        if os.path.isfile(self.path):
            try:
                with open(self.path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                            self.memories.append(entry)
                        except json.JSONDecodeError:
                            logger.warning(f"Skipping corrupt memory entry")
            except Exception as e:
                logger.error(f"Failed to load memory stream: {e}")

        if self.memories:
            # Restore next ID from highest existing ID
            max_id = max(int(m["id"].split("_")[1]) for m in self.memories)
            self._next_id = max_id + 1

        # Restore persisted state (importance_sum, etc.)
        self._load_state()

        logger.info(
            f"Loaded {len(self.memories)} memories from stream "
            f"(importance_sum={self.importance_sum:.1f})"
        )

    def _load_state(self):
        """Restore importance_sum and other state from sidecar JSON."""
        if not os.path.isfile(self._state_path):
            return
        try:
            with open(self._state_path, "r") as f:
                state = json.load(f)
            self.importance_sum = state.get("importance_sum", 0.0)
        except Exception as e:
            logger.warning(f"Could not restore memory state: {e}")

    def _save_state(self):
        """Persist importance_sum to sidecar JSON (atomic write)."""
        state = {"importance_sum": self.importance_sum}
        tmp = self._state_path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(state, f)
            os.replace(tmp, self._state_path)
        except Exception as e:
            logger.error(f"Failed to save memory state: {e}")

    def add(self, content: str, kind: str = "thought", depth: int = 0,
            references: list[str] | None = None) -> dict:
        """Score importance, compute embedding, append to stream."""
        # Score importance via LLM
        importance = self._score_importance(content)

        # Compute embedding
        try:
            embedding = self.provider.embed(content) if self.provider else []
        except Exception as e:
            logger.error(f"Embedding failed: {e}")
            embedding = []

        entry = {
            "id": f"m_{self._next_id:04d}",
            "timestamp": datetime.now().isoformat(),
            "kind": kind,
            "content": content,
            "importance": importance,
            "depth": depth,
            "references": references or [],
            "embedding": embedding,
        }

        self.memories.append(entry)
        self._next_id += 1
        self.importance_sum += importance
        self._save_state()

        # Append to JSONL file
        try:
            with open(self.path, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            logger.error(f"Failed to write memory: {e}")

        logger.info(f"Memory {entry['id']}: importance={importance}, kind={kind}")
        return entry

    def retrieve(self, query: str, top_k: int = None) -> list[dict]:
        """Weighted three-factor retrieval: recency, importance, relevance.

        Scoring: W_RECENCY * recency + W_IMPORTANCE * importance + W_RELEVANCE * relevance
        Reflections are downweighted by REFLECTION_WEIGHT to prevent pollution.
        """
        if top_k is None:
            top_k = config.get("memory_retrieval_count", 3)

        if not self.memories:
            return []

        # Embed the query
        query_embedding = []
        try:
            query_embedding = self.provider.embed(query) if self.provider else []
        except Exception as e:
            logger.warning(f"Query embedding failed, falling back to recency: {e}")
            return self.memories[-top_k:]

        if not query_embedding:
            logger.warning("Empty query embedding — retrieval will be recency-only")

        decay_rate = config.get("recency_decay_rate", 0.995)
        now = datetime.now()
        scored = []

        for mem in self.memories:
            # Recency score (exponential decay over hours)
            try:
                mem_time = datetime.fromisoformat(mem["timestamp"])
                hours_ago = (now - mem_time).total_seconds() / 3600.0
            except Exception:
                hours_ago = 1000.0
            recency = math.exp(-(1 - decay_rate) * hours_ago)

            # Importance score (normalized 0-1)
            importance = mem["importance"] / 10.0

            # Relevance score (cosine similarity)
            if mem.get("embedding") and query_embedding:
                relevance = max(0.0, _cosine_sim(query_embedding, mem["embedding"]))
            else:
                relevance = 0.0

            score = (W_RECENCY * recency
                     + W_IMPORTANCE * importance
                     + W_RELEVANCE * relevance)

            # Downweight reflections to prevent them from crowding out observations
            if mem.get("kind") == "reflection":
                score *= REFLECTION_WEIGHT

            scored.append((score, mem))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [mem for _, mem in scored[:top_k]]

    def should_reflect(self) -> bool:
        """Check if accumulated importance exceeds the reflection threshold."""
        threshold = config.get("reflection_threshold", 50)
        return self.importance_sum >= threshold

    def reset_importance_sum(self):
        """Reset after a reflection cycle."""
        self.importance_sum = 0.0
        self._save_state()

    def get_recent(self, n: int = 10, kind: str | None = None) -> list[dict]:
        """Get the last N memories, optionally filtered by kind."""
        if kind:
            filtered = [m for m in self.memories if m["kind"] == kind]
            return filtered[-n:]
        return self.memories[-n:]

    def _score_importance(self, content: str) -> int:
        """Ask the LLM to rate importance 1-10."""
        try:
            if not self.provider:
                return 5
            result = self.provider.chat_short(
                [{"role": "user", "content": content}],
                instructions=IMPORTANCE_PROMPT,
            )
            # Extract the first integer from the response
            match = re.search(r'\d+', result)
            if match:
                score = int(match.group())
                return max(1, min(10, score))
        except Exception as e:
            logger.error(f"Importance scoring failed: {e}")
        return 5  # default to middle
