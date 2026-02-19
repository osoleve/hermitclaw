# Code Review — Myxo

Thorough review of the Python backend, TypeScript/React frontend, and LLM prompts.

---

## Python Backend

### 1. Bug: `_think_once` returns `None` on failure (brain.py:948)

```python
except Exception as e:
    logger.error(f"LLM call failed: {e}")
    await self._emit("error", text=str(e))
    return  # <-- returns None, not False
```

The caller at line 1321 uses `was_active = await self._think_once()`, and `None` is falsy so it happens to work, but it should explicitly return `False`.

### 2. Unclosed file handles (brain.py:636, 644)

```python
text = open(fpath, "r", errors="replace").read()   # line 636
data = open(fpath, "rb").read()                     # line 644
```

These open files without `with` statements. On CPython the GC will close them promptly, but this is a resource leak on other implementations and trips up linters. Use `with open(...) as f:`.

### 3. OpenAI client created on every call (provider.py:189-190, 256-257)

```python
def _client(self, timeout: float = 120) -> openai.OpenAI:
    return openai.OpenAI(api_key=self.api_key, timeout=timeout)
```

Both `OpenAIProvider` and `LocalProvider` create a new `openai.OpenAI()` instance on every `chat()` and `embed()` call. Each instance spins up a new HTTP connection pool (httpx.Client). This is wasteful — the client should be created once in `__init__` and reused. If different timeouts are needed, create one client for long operations and one for short ones, or set the timeout per-request.

### 4. Inconsistent error handling for tool call JSON parsing (provider.py:219 vs 378)

`OpenAIProvider.chat` does a bare `json.loads(item.arguments)` (line 219) with no try/except, while `LocalProvider.chat` wraps the same operation in a try/except with a `{"_raw": ...}` fallback (line 378-381). If OpenAI ever returns malformed arguments JSON, the brain crashes. Both should have the same safety net.

### 5. Path traversal check is slightly wrong (server.py:327)

```python
full = os.path.realpath(os.path.join(env_root, path))
if not full.startswith(env_root):
```

If `env_root` is `/home/user/myxo_box`, the path `/home/user/myxo_box_evil/secret` would pass the `startswith` check. Fix by ensuring the comparison uses a trailing separator:

```python
if not full.startswith(env_root + os.sep) and full != env_root:
```

### 6. Deprecated FastAPI startup event (server.py:352)

```python
@app.on_event("startup")
```

`on_event("startup")` is deprecated in favor of the `lifespan` context manager pattern. FastAPI 0.100+ recommends:

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # startup
    for creature_id, brain in brains.items():
        asyncio.create_task(_supervise_brain(creature_id, brain))
    yield
    # shutdown
    for brain in brains.values():
        brain.stop()

app = FastAPI(title="Myxo", lifespan=lifespan)
```

### 7. `_get_brain` crashes on empty brains dict (server.py:100)

```python
return next(iter(brains.values()))
```

If no creatures exist, this raises `StopIteration`. Should return a 404 or appropriate error response instead.

### 8. Unbounded `events` list growth (brain.py:317)

`self.events.append(entry)` grows without bound. `api_calls` is correctly capped at 50 (line 335-336), but `events` has no such cap. Over long runs (days), this will consume significant memory. Add a similar cap:

```python
if len(self.events) > 500:
    self.events = self.events[-500:]
```

### 9. No graceful shutdown signal (brain.py:1358-1360)

```python
def stop(self):
    self.running = False
    self.state = "idle"
```

`stop()` doesn't set `_wake_event`, so the creature could block for up to `idle_pace` seconds (60s by default) before actually exiting the loop. Should add `self._wake_event.set()` if the attribute exists.

### 10. `evaluate` and `evaluate_long` code duplication (fold_client.py:127-223)

These two functions are nearly identical — ~90 lines duplicated with only timeout, truncation limit, and error message differences. Refactor to a shared `_evaluate_impl(expression, session_id, timeout, max_length, size_cap)` with the two public functions as thin wrappers.

### 11. Persistent errors dict grows unbounded (brain.py:190, 1047)

`_persistent_errors` only clears entries on successful evaluation of the exact same expression. Over time, unique failed expressions accumulate. Should periodically prune old entries, e.g., clear the dict at the start of each think cycle or limit its size.

### 12. Memory ID parsing is fragile (memory.py:69)

```python
max_id = max(int(m["id"].split("_")[1]) for m in self.memories)
```

If any memory entry has a corrupt or differently-formatted ID, this will crash on startup and the creature won't start. Wrap in a try/except.

### 13. File written with world-readable permissions (main.py:78-79)

```python
with open(env_agents, "w") as f:
    f.write(f"OPENAI_API_KEY={api_key}\n")
```

API keys written to `~/fold/.env.agents` are world-readable by default. Should set restrictive permissions:

```python
import stat
fd = os.open(env_agents, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
with os.fdopen(fd, "w") as f:
    f.write(f"OPENAI_API_KEY={api_key}\n")
```

### 14. Linear scan over all memories on every retrieval (memory.py:168)

`retrieve()` iterates over every memory, computing cosine similarity for each. This is O(n) in the number of memories with a per-item cost that includes a dot product over the embedding dimension. For a creature running continuously, memory grows indefinitely. Consider:
- Capping the number of memories (e.g., keep the most recent 1000, archive older ones)
- Pre-filtering by recency before computing similarity (only score memories from the last N hours)
- Using an approximate nearest neighbor index if the count gets large

### 15. Module-level `.env` parsing is minimal (config.py:11-16)

The hand-rolled `.env` parser doesn't handle quoted values (`KEY="value with spaces"`), values containing `=`, or inline comments. This is fine if the `.env` file is always simple, but a `python-dotenv` dependency or at least a note in the config file would prevent surprises.

---

## TypeScript / React Frontend

### 16. God component — App.tsx is 1305 lines

`App.tsx` contains 20+ useState hooks, 10+ useEffect hooks, message rendering logic, WebSocket management, and ~550 lines of inline style objects all in a single component. This makes it hard to reason about re-render behavior and state flow.

Suggested decomposition:
- **`ChatFeed.tsx`** — message rendering, scrolling, "new messages" pill
- **`ChatInput.tsx`** — input bar, focus mode button, send logic
- **`BbsPanel.tsx`** / **`JournalPanel.tsx`** — the slide-out panels
- **`CreatureSwitcher.tsx`** — the multi-creature tab bar
- **`useCreatureConnection.ts`** — custom hook for WebSocket + REST state loading
- **`styles.ts`** — extract the 550 lines of style objects

### 17. Duplicated palette between App.tsx and world.ts

`App.tsx` defines `P` (line 729-745) and `world.ts` exports `PALETTE` (line 25-39) with overlapping but not identical values. `P` has extra entries (`bbs`, `journal`). These should be unified into a single source of truth — have `App.tsx` import from `world.ts` and extend it.

### 18. Messages array rebuilt on every render (App.tsx:445-491)

The `messages` array is computed inside the render function body by iterating over all `calls`. This runs on every re-render (including position updates, countdown ticks, etc.). It also uses a mutable `seenInputItems` variable that accumulates across iterations — a side effect during rendering.

This should be wrapped in `useMemo` keyed on `calls`:

```tsx
const messages = useMemo(() => {
    const msgs: Msg[] = [];
    let seenInputItems = 0;
    calls.forEach((call, i) => { /* existing logic */ });
    return msgs;
}, [calls]);
```

### 19. WebSocket reconnection has no backoff (App.tsx:233-238)

```typescript
setTimeout(() => {
    if (wsRef.current === ws) connectWs(creatureId);
}, 3000);
```

A flat 3-second reconnect delay means the client will hammer the server if it's down. Use exponential backoff with a cap.

### 20. No React error boundary

If any component throws during rendering (e.g., malformed data from the WebSocket), the entire app crashes with a blank screen. A root-level `<ErrorBoundary>` would improve resilience and show a recovery UI.

### 21. Vite proxy port mismatch (vite.config.ts:9-10)

```typescript
proxy: {
    "/api": "http://localhost:8000",
    "/ws": { target: "ws://localhost:8000", ws: true },
},
```

The proxy points to port 8000, but the default backend port is 8080 (from config.yaml and CLAUDE.md). This means `npm run dev` won't work out of the box unless the developer sets `MYXO_PORT=8000`. Either align the ports or document the discrepancy.

### 22. GameWorld render loop never sleeps (GameWorld.tsx:373-541)

The `requestAnimationFrame` render loop runs at 60fps continuously, even when the tab is backgrounded or nothing is changing. Browsers throttle rAF in background tabs, but when visible, the plasma effect computation runs every frame. Consider:
- Using `document.hidden` to skip frames when the tab is hidden
- Throttling to 30fps since the pixel art aesthetic doesn't benefit from 60fps

### 23. Module-level singleton state in GameWorld (GameWorld.tsx:105-128)

```typescript
let _plasmaCanvas: HTMLCanvasElement | null = null;
let _plasmaCtx: CanvasRenderingContext2D | null = null;
let _plasmaImageData: ImageData | null = null;
```

These module-level globals mean only one `GameWorld` can exist at a time. Since the creature switcher just swaps data (not components), this works, but it would break if multiple GameWorld components were ever rendered simultaneously.

### 24. `React.StrictMode` not used (main.tsx)

```tsx
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
```

No `<React.StrictMode>` wrapper means double-render detection (useful for catching side effects in dev) is disabled. Not critical but recommended for development.

---

## Prompts

### 25. Owner name "Andy" is hardcoded (prompts.py:187-193, 39)

The main system prompt and the `writer` mood nudge both hardcode "Andy" as the owner. With the multi-creature architecture and the creature creation API, different creatures might have different owners. The owner name should come from identity or config:

```python
owner = identity.get("owner", "your owner")
```

### 26. "LOG:" separator is fragile (prompts.py:272, brain.py:1254)

The planning prompt instructs the model to write `LOG:` after the plan, and `brain.py` splits on this literal string. If the model includes "LOG:" in the plan body itself (e.g., "Check the LOG: entries from yesterday"), the split happens at the wrong point. Use a more distinctive separator like `---LOG---` or `\n===LOG===\n`, or parse the structure differently.

### 27. Reflection prompt output format assumption (prompts.py:241, brain.py:1198)

The prompt says "one per line" but `brain.py` splits on `\n` and stores each line as a separate reflection memory. If the model outputs numbered insights ("1. ..."), blank lines between insights, or multi-sentence insights with line wraps, the parsing will either fragment insights or include numbering/whitespace. The `line.strip()` and empty-line filter helps, but consider stripping leading numbers/bullets too.

### 28. `max_tokens=300` default is quite low (provider.py:165)

The default `max_tokens=300` in `Provider.chat()` is fine for short thoughts but constraining for tool-heavy cycles where the model needs to emit both reasoning text and a tool call. Tool calls count toward this limit in some API implementations. The `_think_once` path doesn't override this default — it relies on the default 300. Consider bumping the default to 500-800 for the main thinking loop, or make it configurable.

### 29. Importance scoring uses the main (expensive) model (memory.py:221)

Every `stream.add()` call triggers an LLM call via `provider.chat_short()` to score importance 1-10. This uses the same model configured for thinking (currently `kimi-k2.5` via OpenRouter). This is expensive for what is essentially a classification task. Consider:
- Using the local summarizer model for importance scoring too
- Batching importance scores (score multiple memories at once)
- Using a heuristic fallback (keyword-based, length-based) and only LLM-scoring for high-signal memories

### 30. Main system prompt is very long (~200 lines)

The system prompt covers creature nature, room layout, Fold capabilities, BBS usage, RLM usage, owner info, file handling, voice handling, mood/focus, and style instructions. This is thorough but at ~3000 tokens it's a significant chunk of context. Some models may lose adherence to instructions that appear early in a long system prompt.

Consider:
- Moving stable reference information (room locations, BBS commands, Fold commands) into a separate "reference card" injected as a user message rather than system instructions
- Keeping the system prompt focused on behavioral instructions (personality, style, priorities)
- Making the owner bio section shorter or conditional (only include on first cycle)

---

## Cross-cutting Concerns

### 31. No retry logic for LLM calls

When an LLM call fails in `_think_once` (line 945-948), the creature logs the error and skips the cycle. For transient failures (rate limits, network blips), a single retry with backoff would improve uptime. The supervisor handles full crashes, but individual call failures silently skip cycles.

### 32. No test suite

As noted in CLAUDE.md, there's no test suite or linter. Given the complexity of the tool loop, provider abstraction, and memory retrieval, even a small set of unit tests would catch regressions:
- `_compact_tool_context` with various input shapes
- `_convert_input` round-trip consistency
- `_cosine_sim` edge cases
- `_parse_response` with various S-expression formats
- Importance score parsing from model output

### 33. Creature creation code duplication (main.py:85-112)

The "brains exist" path and "no brains" path duplicate the creature setup logic (get config, create provider, instantiate Brain, add to dict). Extract a `_create_brain(creature_id, box_path)` helper.

### 34. WebSocket doesn't process incoming messages (server.py:124-126)

```python
while True:
    await ws.receive_text()  # keep connection alive
```

The WebSocket handler discards all incoming text. If the frontend ever needs to send messages over the WebSocket (e.g., chat messages, commands), this would need to change. Currently chat goes through the REST `/api/message` endpoint, which works but adds latency vs. using the already-open WebSocket.

---

## Summary of priorities

**Bugs to fix:**
- `_think_once` returning `None` (#1)
- Unclosed file handles (#2)
- Path traversal check (#5)
- Vite proxy port mismatch (#21)

**Quick wins for robustness:**
- Cache OpenAI client (#3)
- Consistent JSON parsing safety (#4)
- Graceful shutdown signal (#9)
- Empty brains dict guard (#7)
- Events list cap (#8)
- Fragile memory ID parsing (#12)

**Architecture improvements:**
- Decompose App.tsx (#16)
- Deduplicate fold_client.py (#10)
- Memoize messages array (#18)
- Unify palette constants (#17)
- Use cheaper model for importance scoring (#29)

**Prompt improvements:**
- Parameterize owner name (#25)
- Use robust LOG separator (#26)
- Consider shorter system prompt (#30)
- Bump max_tokens for thinking (#28)
