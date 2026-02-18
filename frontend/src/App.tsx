import { useEffect, useRef, useState, useCallback } from "react";
import GameWorld, { GameWorldHandle } from "./GameWorld";

interface ApiCall {
  timestamp: string;
  instructions: string;
  input: Array<Record<string, unknown>>;
  output: Array<Record<string, unknown>>;
  is_dream?: boolean;
  is_planning?: boolean;
}

interface CrabInfo {
  id: string;
  name: string;
  state: string;
  thought_count: number;
}

type Phase = "normal" | "dream" | "planning";
type Msg = { side: "left" | "right" | "system"; text: string; phase: Phase; image?: string; isRespond?: boolean; isOwner?: boolean };

/**
 * Render an INPUT item — we only care about:
 *  - user messages (nudges like "Continue." or "You're awake...")
 *  - function_call_output (tool results we sent back to the model)
 * Everything else in input is accumulated history (already rendered).
 */
function renderInputItem(item: Record<string, unknown>, phase: Phase): Msg | null {
  if (item.role === "user") {
    const content = item.content;
    // Content can be a string or an array (when it includes an image)
    if (typeof content === "string") {
      // Detect owner voice messages and extract just the spoken text
      const voiceMatch = content.match(/^You hear a voice from outside your room say: "(.+?)"\n/s);
      if (voiceMatch) {
        return { side: "left", text: voiceMatch[1], phase, isOwner: true };
      }
    }
    if (Array.isArray(content)) {
      let text = "";
      let image: string | undefined;
      for (const part of content) {
        if (part.type === "input_text") text = part.text as string;
        if (part.type === "input_image") image = part.image_url as string;
      }
      // Check text part for owner voice pattern too
      const voiceMatch = text.match(/^You hear a voice from outside your room say: "(.+?)"\n/s);
      if (voiceMatch) {
        return { side: "left", text: voiceMatch[1], phase, isOwner: true, image };
      }
      return { side: "left", text: text || "[image]", phase, image };
    }
    return { side: "left", text: content as string, phase };
  }
  if (item.type === "function_call_output") {
    return { side: "left", text: item.output as string, phase };
  }
  // Local provider: tool result
  if (item.role === "tool") {
    return { side: "left", text: item.content as string, phase };
  }
  return null;
}

/**
 * Render an OUTPUT item — everything the model returned:
 *  - message (thinking text)
 *  - function_call (tool invocation)
 *  - web_search_call
 */
function renderFunctionCall(name: string, rawArgs: unknown, phase: Phase): Msg | null {
  const parsed = (() => {
    try { return typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs; }
    catch { return rawArgs; }
  })() as Record<string, string> | undefined;

  if (name === "respond") {
    const text = parsed?.message || String(rawArgs || "");
    return text ? { side: "right", text, phase, isRespond: true } : null;
  }
  let cmd: string;
  if (name === "fold") {
    cmd = parsed?.expression ? `> ${parsed.expression}` : "> (empty)";
  } else if (name === "move") {
    cmd = `[move → ${parsed?.location || "?"}]`;
  } else {
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs, null, 2);
    cmd = `[${name || "?"}] ${args}`;
  }
  return { side: "right", text: cmd, phase };
}

function renderOutputItem(item: Record<string, unknown>, phase: Phase): Msg | null {
  // OpenAI Responses API: SDK message object
  if (item.type === "message") {
    const content = item.content as Array<Record<string, unknown>>;
    const text = content
      ?.map((c) => (c.text as string) || `[${c.type}]`)
      .join("\n");
    if (text) return { side: "right", text, phase };
    return null;
  }
  // OpenAI Responses API: SDK function_call object
  if (item.type === "function_call") {
    return renderFunctionCall(item.name as string, item.arguments, phase);
  }
  // Local provider (Chat Completions): assistant message with tool_calls
  if (item._local_type === "assistant_with_tools") {
    const msg = item._message as Record<string, unknown>;
    const tcs = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (tcs) {
      // Return first tool call (usually only one per output item)
      const tc = tcs[0];
      const fn = tc?.function as Record<string, unknown>;
      if (fn) return renderFunctionCall(fn.name as string, fn.arguments, phase);
    }
    return null;
  }
  // Local provider: plain assistant message
  if (item.role === "assistant" && item.content) {
    return { side: "right", text: item.content as string, phase };
  }
  if (item.type === "web_search_call") {
    return { side: "right", text: "[web search]", phase };
  }
  return null;
}

export default function App() {
  const [calls, setCalls] = useState<ApiCall[]>([]);
  const [position, setPosition] = useState({ x: 5, y: 5 });
  const [crabState, setCrabState] = useState("idle");
  const [alert, setAlert] = useState(false);
  const [activity, setActivity] = useState({ type: "idle", detail: "" });
  const [chatInput, setChatInput] = useState("");
  const [conversing, setConversing] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [hasNew, setHasNew] = useState(false);
  const [crabName, setCrabName] = useState("myxo");
  const [focusMode, setFocusMode] = useState(false);
  const [crabs, setCrabs] = useState<CrabInfo[]>([]);
  const [activeCrab, setActiveCrab] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameWorldHandle>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const crabParam = activeCrab ? `?crab=${activeCrab}` : "";

  const connectWs = useCallback((crabId: string) => {
    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/${crabId}`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.event === "api_call") setCalls((prev) => [...prev, msg.data]);
      if (msg.event === "position") setPosition(msg.data);
      if (msg.event === "status") {
        setCrabState(msg.data.state);
        if (msg.data.state === "thinking") setAlert(false);
      }
      if (msg.event === "alert") setAlert(true);
      if (msg.event === "activity") setActivity(msg.data);
      if (msg.event === "focus_mode") setFocusMode(msg.data.enabled);
      if (msg.event === "conversation") {
        if (msg.data.state === "waiting") {
          setConversing(true);
          setCountdown(msg.data.timeout);
        } else if (msg.data.state === "ended") {
          setConversing(false);
          setCountdown(0);
        }
      }
    };

    ws.onerror = () => {
      console.warn(`WebSocket error for crab ${crabId}`);
    };

    ws.onclose = () => {
      // Reconnect after a brief delay if this is still the active WS
      if (wsRef.current === ws) {
        setTimeout(() => {
          if (wsRef.current === ws) connectWs(crabId);
        }, 3000);
      }
    };
  }, []);

  const loadCrabState = useCallback(async (crabId: string) => {
    const q = `?crab=${crabId}`;
    // Fetch historical calls first (before WS connects) to avoid race
    try {
      const [rawRes, statusRes, idRes] = await Promise.all([
        fetch(`/api/raw${q}`),
        fetch(`/api/status${q}`),
        fetch(`/api/identity${q}`),
      ]);
      const rawData = await rawRes.json();
      const statusData = await statusRes.json();
      const idData = await idRes.json();
      setCalls(rawData);
      if (statusData.position) setPosition(statusData.position);
      if (statusData.focus_mode !== undefined) setFocusMode(statusData.focus_mode);
      setCrabState(statusData.state || "idle");
      if (idData.name) setCrabName(idData.name);
    } catch {
      // silently ignore fetch errors
    }
  }, []);

  // Initial mount: fetch crabs list, load state, then connect WS
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/crabs");
        const list: CrabInfo[] = await res.json();
        if (cancelled) return;
        setCrabs(list);
        if (list.length > 0) {
          const first = list[0].id;
          setActiveCrab(first);
          setCrabName(list[0].name);
          // Load historical data first, then connect WS for live events
          await loadCrabState(first);
          if (!cancelled) connectWs(first);
        }
      } catch { /* server not ready yet */ }
    })();

    return () => {
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connectWs, loadCrabState]);

  // Switch crab
  const switchCrab = useCallback((crabId: string) => {
    if (crabId === activeCrab) return;
    setActiveCrab(crabId);

    // Reset state
    setConversing(false);
    setCountdown(0);
    setAlert(false);
    setActivity({ type: "idle", detail: "" });
    setHasNew(false);

    // Update crab name immediately
    const crab = crabs.find((c) => c.id === crabId);
    if (crab) setCrabName(crab.name);

    // Load historical data first, then connect WS for live events
    loadCrabState(crabId).then(() => connectWs(crabId));
  }, [activeCrab, crabs, loadCrabState, connectWs]);

  // Poll crabs list periodically to keep states fresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/crabs")
        .then((r) => r.json())
        .then(setCrabs)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Countdown timer for conversation window
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (countdown > 0) {
      countdownRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            clearInterval(countdownRef.current!);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    }
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [conversing]);

  // Send canvas snapshot to backend when thinking starts
  useEffect(() => {
    if (crabState === "thinking" && gameRef.current) {
      const dataUrl = gameRef.current.snapshot();
      if (dataUrl) {
        fetch(`/api/snapshot${crabParam}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl }),
        }).catch(() => {});
      }
    }
  }, [crabState, crabParam]);

  // Auto-scroll: track whether user is "pinned" to bottom
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      if (pinnedRef.current) setHasNew(false);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // When calls change, scroll to bottom if pinned
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      // Use requestAnimationFrame to ensure DOM has laid out new content
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    } else {
      setHasNew(true);
    }
  }, [calls.length]);


  const sendMessage = () => {
    const text = chatInput.trim();
    if (!text) return;
    fetch(`/api/message${crabParam}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    setChatInput("");
  };

  const toggleFocusMode = () => {
    const next = !focusMode;
    setFocusMode(next);
    fetch(`/api/focus-mode${crabParam}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    }).catch(() => {});
  };

  // Build a deduplicated conversation stream.
  // Each API call's input contains the FULL accumulated history.
  // We only render NEW items in each call's input (items we haven't seen yet)
  // plus all output items (what the model returned).
  const messages: Msg[] = [];
  let seenInputItems = 0;

  calls.forEach((call, i) => {
    const isDream = call.is_dream ?? false;
    const isPlanning = call.is_planning ?? false;
    const phase: Phase = isDream ? "dream" : isPlanning ? "planning" : "normal";

    // System prompt (first call or when instructions meaningfully changed) — skip for dream/planning calls
    const strip = (s: string) => s.replace(/Right now it is .+\n/, "").replace(/## Current (mood|focus)\n[\s\S]*?(?=\n##)/, "");
    if (!isDream && !isPlanning && (i === 0 || strip(call.instructions) !== strip(calls[i - 1]?.instructions ?? ""))) {
      messages.push({ side: "system", text: call.instructions, phase: "normal" });
    }

    // Dream divider
    if (isDream && (i === 0 || !calls[i - 1]?.is_dream)) {
      messages.push({ side: "system", text: "Reflecting...", phase: "dream" });
    }

    // Planning divider
    if (isPlanning && (i === 0 || !calls[i - 1]?.is_planning)) {
      messages.push({ side: "system", text: "Planning...", phase: "planning" });
    }

    // If input didn't grow (rebuilt from scratch for a new think cycle), reset.
    // Accumulated tool-loop inputs always grow strictly (new function_call_outputs),
    // so equal-or-smaller means the input was rebuilt by _build_input().
    if (seenInputItems >= call.input.length) {
      seenInputItems = 0;
    }

    // Only render NEW input items (skip already-rendered history)
    const newInputs = call.input.slice(seenInputItems);
    for (const item of newInputs) {
      const msg = renderInputItem(item, phase);
      if (msg) messages.push(msg);
    }

    // Render all output items (what the model returned this call)
    for (const item of call.output) {
      const msg = renderOutputItem(item, phase);
      if (msg) messages.push(msg);
    }

    // Track how many items the next call's input will start with
    seenInputItems = call.input.length + call.output.length;
  });

  const stateColor = (s: string) => {
    if (s === "thinking") return P.glow;
    if (s === "reflecting") return P.dream;
    if (s === "planning") return P.plan;
    return P.dim;
  };

  // Determine card style based on message type
  const cardStyle = (msg: Msg): React.CSSProperties => {
    const base: React.CSSProperties = {
      ...cardBase,
    };

    if (msg.isOwner) return { ...base, borderLeft: `3px solid ${P.owner}` };
    if (msg.isRespond) return { ...base, borderLeft: `3px solid ${P.respond}`, background: "#131a28" };

    if (msg.side === "left") {
      // Tool results — visually subordinate
      return { ...base, color: P.dim, fontSize: 11, padding: "6px 14px" };
    }

    // Right side (creature output)
    if (msg.phase === "dream") return { ...base, borderLeft: `3px solid ${P.dream}`, background: "#140f20" };
    if (msg.phase === "planning") return { ...base, borderLeft: `3px solid ${P.plan}`, background: "#0f1a18" };

    // Fold expressions — amber accent
    if (msg.text.startsWith(">")) return { ...base, borderLeft: `3px solid ${P.computation}`, background: "#111a28" };

    // Move commands
    if (msg.text.startsWith("[move")) return { ...base, color: P.dim, fontSize: 11, padding: "6px 14px" };

    // Normal thought — teal accent
    return { ...base, borderLeft: `3px solid ${P.glow}` };
  };

  return (
    <div style={page}>
      <div style={headerBar}>
        <div style={headerDot(stateColor(crabState))} />
        <span style={headerTitle}>{crabName}</span>
        <span style={headerState}>{crabState}</span>
      </div>
      <div style={twoPane}>
        {/* Left pane — Game world */}
        <div style={gamePane}>
          <GameWorld ref={gameRef} position={position} state={crabState} alert={alert} activity={activity} conversing={conversing} />
        </div>

        {/* Right pane — Chat feed */}
        <div style={chatPane}>
          {/* Creature switcher */}
          {crabs.length > 1 && (
            <div style={switcherBar}>
              {crabs.map((c) => {
                const isActive = c.id === activeCrab;
                return (
                  <button
                    key={c.id}
                    style={isActive ? switcherBtnActive : switcherBtnInactive}
                    onClick={() => switchCrab(c.id)}
                  >
                    <span style={switcherDot(stateColor(c.state))} />
                    <span>{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div ref={scrollRef} style={chatScroll}>
          <div style={container}>
            {messages.length === 0 && (
              <div style={emptyState}>
                <div style={emptyDot} />
                <div style={emptyTitle}>Waiting for thoughts...</div>
                <div style={emptySubtitle}>{crabName} is waking up</div>
              </div>
            )}
            {messages.map((msg, i) => {
              if (msg.side === "system") {
                const sBlock = msg.phase === "dream" ? dreamSystemBlock
                  : msg.phase === "planning" ? planSystemBlock : systemBlock;
                const sLabel = msg.phase === "dream" ? dreamSystemLabel
                  : msg.phase === "planning" ? planSystemLabel : systemLabel;
                const sText = msg.phase === "dream" ? dreamSystemText
                  : msg.phase === "planning" ? planSystemText : systemText;
                const label = msg.phase === "dream" ? "Reflection"
                  : msg.phase === "planning" ? "Planning" : "System Prompt";
                return (
                  <div key={i} style={sBlock}>
                    <div style={sLabel}>{label}</div>
                    <pre style={sText}>{msg.text}</pre>
                  </div>
                );
              }

              return (
                <div key={i} style={{ marginBottom: 4 }}>
                  <div style={cardStyle(msg)}>
                    {msg.image && (
                      <img
                        src={msg.image}
                        style={snapshotImg}
                        alt="Room snapshot"
                      />
                    )}
                    <pre style={cardText}>
                      {msg.text}
                    </pre>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
          </div>
          {hasNew && (
            <div
              style={newMsgPill}
              onClick={() => {
                bottomRef.current?.scrollIntoView({ behavior: "smooth" });
                setHasNew(false);
              }}
            >
              New messages
            </div>
          )}
          <div style={inputBar}>
            {conversing && countdown > 0 && (
              <div style={countdownStyle}>{countdown}s</div>
            )}
            <button
              style={focusMode ? focusBtnActive : focusBtnInactive}
              onClick={toggleFocusMode}
              title={focusMode ? "Focus mode ON — click to turn off" : "Focus mode OFF — click to turn on"}
            >
              Focus
            </button>
            <form
              style={inputForm}
              onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
            >
              <input
                style={inputField}
                type="text"
                placeholder={conversing ? `Reply to ${crabName}...` : `Say something to ${crabName}...`}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
              />
              <button style={sendBtn} type="submit">Send</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Palette shorthand ──
const P = {
  void:        "#080c14",
  surface:     "#0f1520",
  border:      "#1a2535",
  glow:        "#00e5a0",
  glowCyan:    "#00c8ff",
  computation: "#f0b040",
  dream:       "#a78bfa",
  plan:        "#34d399",
  respond:     "#f97316",
  owner:       "#60a5fa",
  error:       "#f87171",
  text:        "#c8d6e5",
  dim:         "#5a6a7a",
};

const MONO = "'IBM Plex Mono', monospace";

const page: React.CSSProperties = {
  background: P.void,
  color: P.text,
  fontFamily: MONO,
  height: "100vh",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

// ── Header ──
const headerBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 24px",
  background: P.void,
  borderBottom: `1px solid ${P.border}`,
  flexShrink: 0,
};

const headerDot = (color: string): React.CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: color,
  boxShadow: `0 0 6px ${color}`,
  flexShrink: 0,
});

const headerTitle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: P.text,
  whiteSpace: "nowrap",
  fontFamily: MONO,
};

const headerState: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 400,
  color: P.dim,
  fontFamily: MONO,
};

// ── Layout ──
const twoPane: React.CSSProperties = {
  display: "flex",
  flex: 1,
  overflow: "hidden",
};

const gamePane: React.CSSProperties = {
  width: "45%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: P.void,
  padding: 20,
  flexShrink: 0,
};

const chatPane: React.CSSProperties = {
  width: "55%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: P.surface,
  borderLeft: `1px solid ${P.border}`,
};

const chatScroll: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
};

const container: React.CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "16px 16px",
};

// ── Empty state ──
const emptyState: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "80px 20px",
  gap: 12,
};

const emptyDot: React.CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: P.glow,
  boxShadow: `0 0 12px ${P.glow}`,
  animation: "pulse 2s ease-in-out infinite",
};

const emptyTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: P.dim,
  fontFamily: MONO,
};

const emptySubtitle: React.CSSProperties = {
  fontSize: 12,
  color: P.dim,
  fontFamily: MONO,
  opacity: 0.6,
};

// ── Creature switcher ──
const switcherBar: React.CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "8px 16px",
  borderBottom: `1px solid ${P.border}`,
  background: P.void,
  overflowX: "auto",
  flexShrink: 0,
};

const switcherBtnBase: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 14px",
  borderRadius: 6,
  border: `1px solid ${P.border}`,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: MONO,
  background: "transparent",
  color: P.dim,
};

const switcherBtnActive: React.CSSProperties = {
  ...switcherBtnBase,
  background: P.surface,
  color: P.text,
  borderColor: P.glow + "44",
};

const switcherBtnInactive: React.CSSProperties = {
  ...switcherBtnBase,
};

const switcherDot = (color: string): React.CSSProperties => ({
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: color,
  boxShadow: `0 0 4px ${color}`,
  flexShrink: 0,
});

// ── Chat cards ──
const cardBase: React.CSSProperties = {
  padding: "8px 14px",
  background: P.surface,
  borderRadius: 4,
  fontFamily: MONO,
  fontSize: 12.5,
  lineHeight: "1.6",
  color: P.text,
};

const cardText: React.CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: MONO,
  fontSize: "inherit",
  lineHeight: "inherit",
  color: "inherit",
};

const snapshotImg: React.CSSProperties = {
  width: "100%",
  maxWidth: 200,
  borderRadius: 4,
  marginBottom: 6,
};

// ── System blocks ──
const systemBlock: React.CSSProperties = {
  background: P.void,
  borderRadius: 4,
  padding: "10px 14px",
  marginBottom: 8,
  border: `1px solid ${P.border}`,
};

const systemLabel: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  color: P.dim,
  textTransform: "uppercase",
  marginBottom: 6,
  letterSpacing: "0.8px",
  fontFamily: MONO,
};

const systemText: React.CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: 11,
  lineHeight: "1.5",
  color: P.dim,
  fontFamily: MONO,
  opacity: 0.7,
};

const dreamSystemBlock: React.CSSProperties = {
  ...systemBlock,
  borderColor: P.dream + "33",
  background: "#0f0c1a",
};

const dreamSystemLabel: React.CSSProperties = {
  ...systemLabel,
  color: P.dream,
};

const dreamSystemText: React.CSSProperties = {
  ...systemText,
  color: P.dream,
  opacity: 0.6,
};

const planSystemBlock: React.CSSProperties = {
  ...systemBlock,
  borderColor: P.plan + "33",
  background: "#0c1410",
};

const planSystemLabel: React.CSSProperties = {
  ...systemLabel,
  color: P.plan,
};

const planSystemText: React.CSSProperties = {
  ...systemText,
  color: P.plan,
  opacity: 0.6,
};

// ── Input bar ──
const inputBar: React.CSSProperties = {
  borderTop: `1px solid ${P.border}`,
  padding: "10px 16px",
  background: P.void,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const inputForm: React.CSSProperties = {
  display: "flex",
  flex: 1,
  gap: 8,
};

const inputField: React.CSSProperties = {
  flex: 1,
  padding: "9px 14px",
  borderRadius: 6,
  border: `1px solid ${P.border}`,
  fontSize: 13,
  fontFamily: MONO,
  outline: "none",
  background: P.surface,
  color: P.text,
};

const sendBtn: React.CSSProperties = {
  padding: "9px 18px",
  borderRadius: 6,
  border: "none",
  background: P.glow,
  color: P.void,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: MONO,
};

const countdownStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: P.respond,
  fontFamily: MONO,
  minWidth: 30,
};

const focusBtnInactive: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 6,
  border: `1px solid ${P.border}`,
  background: "transparent",
  color: P.dim,
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: MONO,
};

const focusBtnActive: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 6,
  border: `1px solid ${P.respond}`,
  background: P.respond,
  color: "#fff",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: MONO,
};

const newMsgPill: React.CSSProperties = {
  textAlign: "center",
  padding: "6px 0",
  background: `${P.void}dd`,
  color: P.glow,
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: MONO,
  borderTop: `1px solid ${P.border}`,
};
