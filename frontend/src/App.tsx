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

interface CreatureInfo {
  id: string;
  name: string;
  state: string;
  thought_count: number;
}

interface BbsIssue {
  id: string;
  timestamp: string;
  title: string;
  description: string;
  type: string;
  priority: number;
  labels: string[];
  fold_result?: string;
}

interface JournalEntry {
  text: string;
  timestamp: string;
}

interface RlmRun {
  id: string;
  task: string;
  status: "running" | "completed" | "exhausted" | "error" | string;
  output: string;
  timestamp: string;
}

type Phase = "normal" | "dream" | "planning";
type Msg = { side: "left" | "right" | "system"; text: string; phase: Phase; image?: string; isRespond?: boolean; isOwner?: boolean; isBbs?: boolean; isRlm?: boolean };

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
  if (name === "bbs") {
    const title = parsed?.title || "";
    const type = parsed?.type || "note";
    const text = title ? `[BBS ${type}] ${title}` : String(rawArgs || "");
    return text ? { side: "right", text, phase, isBbs: true } : null;
  }
  if (name === "rlm") {
    const task = parsed?.task || String(rawArgs || "");
    return { side: "right", text: `[RLM deep dive] ${task}`, phase, isRlm: true };
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
  const [creatureState, setCreatureState] = useState("idle");
  const [alert, setAlert] = useState(false);
  const [activity, setActivity] = useState({ type: "idle", detail: "" });
  const [chatInput, setChatInput] = useState("");
  const [conversing, setConversing] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [hasNew, setHasNew] = useState(false);
  const [pendingVoice, setPendingVoice] = useState<string | null>(null);
  const [creatureName, setCreatureName] = useState("myxo");
  const [focusMode, setFocusMode] = useState(false);
  const [bbsIssues, setBbsIssues] = useState<BbsIssue[]>([]);
  const [bbsOpen, setBbsOpen] = useState(false);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [journalOpen, setJournalOpen] = useState(false);
  const [rlmRuns, setRlmRuns] = useState<RlmRun[]>([]);
  const [rlmOpen, setRlmOpen] = useState(false);
  const [creatures, setCreatures] = useState<CreatureInfo[]>([]);
  const [activeCreature, setActiveCreature] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameWorldHandle>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const creatureParam = activeCreature ? `?creature=${activeCreature}` : "";

  const connectWs = useCallback((creatureId: string) => {
    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/${creatureId}`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.event === "api_call") {
        setCalls((prev) => [...prev, msg.data]);
        setPendingVoice(null);
      }
      if (msg.event === "position") setPosition(msg.data);
      if (msg.event === "status") {
        setCreatureState(msg.data.state);
        if (msg.data.state === "thinking") setAlert(false);
      }
      if (msg.event === "alert") setAlert(true);
      if (msg.event === "activity") setActivity(msg.data);
      if (msg.event === "focus_mode") setFocusMode(msg.data.enabled);
      if (msg.event === "bbs") {
        setBbsIssues((prev) => [...prev, msg.data]);
      }
      if (msg.event === "journal") {
        setJournalEntries((prev) => [...prev, msg.data]);
      }
      if (msg.event === "rlm") {
        const run = msg.data as RlmRun;
        setRlmRuns((prev) => {
          const idx = prev.findIndex((r) => r.id === run.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = run;
            return updated;
          }
          return [...prev, run];
        });
        if (run.status === "running") setRlmOpen(true);
      }
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
      console.warn(`WebSocket error for creature ${creatureId}`);
    };

    ws.onclose = () => {
      // Reconnect after a brief delay if this is still the active WS
      if (wsRef.current === ws) {
        setTimeout(() => {
          if (wsRef.current === ws) connectWs(creatureId);
        }, 3000);
      }
    };
  }, []);

  const loadCreatureState = useCallback(async (creatureId: string) => {
    const q = `?creature=${creatureId}`;
    // Fetch historical calls first (before WS connects) to avoid race
    try {
      const [rawRes, statusRes, idRes, bbsRes, journalRes, rlmRes] = await Promise.all([
        fetch(`/api/raw${q}`),
        fetch(`/api/status${q}`),
        fetch(`/api/identity${q}`),
        fetch(`/api/bbs${q}`),
        fetch(`/api/journal${q}`),
        fetch(`/api/rlm${q}`),
      ]);
      const rawData = await rawRes.json();
      const statusData = await statusRes.json();
      const idData = await idRes.json();
      const bbsData: BbsIssue[] = await bbsRes.json();
      const journalData = await journalRes.json();
      const rlmData: RlmRun[] = await rlmRes.json();
      setCalls(rawData);
      if (statusData.position) setPosition(statusData.position);
      if (statusData.focus_mode !== undefined) setFocusMode(statusData.focus_mode);
      setCreatureState(statusData.state || "idle");
      if (idData.name) setCreatureName(idData.name);
      setBbsIssues(bbsData);
      setRlmRuns(rlmData);
      // Parse journal content into entries
      if (journalData.content) {
        const entries: JournalEntry[] = [];
        const sections = journalData.content.split(/\n## /).filter(Boolean);
        for (const section of sections) {
          const lines = section.split("\n");
          const timeStr = lines[0].replace("## ", "").trim();
          const text = lines.slice(1).join("\n").trim();
          if (text) {
            entries.push({ text, timestamp: timeStr });
          }
        }
        setJournalEntries(entries);
      } else {
        setJournalEntries([]);
      }
    } catch {
      // silently ignore fetch errors
    }
  }, []);

  // Initial mount: fetch creatures list, load state, then connect WS
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/creatures");
        const list: CreatureInfo[] = await res.json();
        if (cancelled) return;
        setCreatures(list);
        if (list.length > 0) {
          const first = list[0].id;
          setActiveCreature(first);
          setCreatureName(list[0].name);
          // Load historical data first, then connect WS for live events
          await loadCreatureState(first);
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
  }, [connectWs, loadCreatureState]);

  // Switch creature
  const switchCreature = useCallback((creatureId: string) => {
    if (creatureId === activeCreature) return;
    setActiveCreature(creatureId);

    // Reset state
    setConversing(false);
    setCountdown(0);
    setAlert(false);
    setActivity({ type: "idle", detail: "" });
    setHasNew(false);
    setBbsIssues([]);
    setBbsOpen(false);
    setJournalEntries([]);
    setJournalOpen(false);
    setRlmRuns([]);
    setRlmOpen(false);

    // Update creature name immediately
    const creature = creatures.find((c) => c.id === creatureId);
    if (creature) setCreatureName(creature.name);

    // Load historical data first, then connect WS for live events
    loadCreatureState(creatureId).then(() => connectWs(creatureId));
  }, [activeCreature, creatures, loadCreatureState, connectWs]);

  // Poll creatures list periodically to keep states fresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/creatures")
        .then((r) => r.json())
        .then(setCreatures)
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
    if (creatureState === "thinking" && gameRef.current) {
      const dataUrl = gameRef.current.snapshot();
      if (dataUrl) {
        fetch(`/api/snapshot${creatureParam}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl }),
        }).catch(() => {});
      }
    }
  }, [creatureState, creatureParam]);

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

  // Scroll to bottom when user sends a message
  useEffect(() => {
    if (pendingVoice && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current!.scrollTop = scrollRef.current!.scrollHeight;
      });
    }
  }, [pendingVoice]);

  const sendMessage = () => {
    const text = chatInput.trim();
    if (!text) return;
    setPendingVoice(text);
    fetch(`/api/message${creatureParam}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    setChatInput("");
  };

  const bbsCount = bbsIssues.length;
  const journalCount = journalEntries.length;

  const toggleFocusMode = () => {
    const next = !focusMode;
    setFocusMode(next);
    fetch(`/api/focus-mode${creatureParam}`, {
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
    if (msg.isBbs) return { ...base, borderLeft: `3px solid ${P.bbs}`, background: "#1a1708" };
    if (msg.isRlm) return { ...base, borderLeft: `3px solid ${P.rlm}`, background: "#0f0f1a" };
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
        <div style={headerDot(stateColor(creatureState))} />
        <span style={headerTitle}>{creatureName}</span>
        <span style={headerState}>{creatureState}</span>
        <div style={{ flex: 1 }} />
        {rlmRuns.length > 0 && (
          <button
            style={rlmRuns.some((r) => r.status === "running") ? rlmBadgeBtnActive : rlmBadgeBtn}
            onClick={() => setRlmOpen(!rlmOpen)}
            title="RLM deep explorations"
          >
            RLM ({rlmRuns.length})
          </button>
        )}
        {journalCount > 0 && (
          <button
            style={journalBadgeBtn}
            onClick={() => setJournalOpen(!journalOpen)}
            title="Journal entries"
          >
            Journal ({journalCount})
          </button>
        )}
        {bbsCount > 0 && (
          <button
            style={bbsBadgeBtn}
            onClick={() => setBbsOpen(!bbsOpen)}
            title="BBS issues filed"
          >
            BBS ({bbsCount})
          </button>
        )}
      </div>
      <div style={twoPane}>
        {/* Left pane — Game world */}
        <div style={gamePane}>
          <GameWorld ref={gameRef} position={position} state={creatureState} alert={alert} activity={activity} conversing={conversing} />
        </div>

        {/* Right pane — Chat feed */}
        <div style={chatPane}>
          {/* Creature switcher */}
          {creatures.length > 1 && (
            <div style={switcherBar}>
              {creatures.map((c) => {
                const isActive = c.id === activeCreature;
                return (
                  <button
                    key={c.id}
                    style={isActive ? switcherBtnActive : switcherBtnInactive}
                    onClick={() => switchCreature(c.id)}
                  >
                    <span style={switcherDot(stateColor(c.state))} />
                    <span>{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {rlmOpen && rlmRuns.length > 0 && (
            <div style={rlmPanel}>
              <div style={rlmPanelHeader}>
                <span style={rlmPanelTitle}>Deep Exploration</span>
                <button style={rlmCloseBtn} onClick={() => setRlmOpen(false)}>Close</button>
              </div>
              <div style={rlmPanelScroll}>
                {[...rlmRuns].reverse().map((run) => (
                  <div key={run.id} style={rlmItem}>
                    <div style={rlmItemHeader}>
                      <span style={rlmStatusBadge(run.status)}>
                        {run.status === "running" ? "running..." : run.status}
                      </span>
                      <span style={rlmItemTime}>
                        {new Date(run.timestamp).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    </div>
                    <div style={rlmItemTask}>{run.task}</div>
                    {run.output && run.status !== "running" && (
                      <div style={rlmItemOutput}>{run.output}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {journalOpen && journalEntries.length > 0 && (
            <div style={journalPanel}>
              <div style={journalPanelHeader}>
                <span style={journalPanelTitle}>Journal</span>
                <button style={journalCloseBtn} onClick={() => setJournalOpen(false)}>Close</button>
              </div>
              <div style={journalPanelScroll}>
                {[...journalEntries].reverse().map((entry, idx) => (
                  <div key={idx} style={journalEntry}>
                    <div style={journalEntryTime}>
                      {entry.timestamp.includes("T")
                        ? new Date(entry.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                        : entry.timestamp}
                    </div>
                    <div style={journalEntryText}>{entry.text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {bbsOpen && bbsIssues.length > 0 && (
            <div style={bbsPanel}>
              <div style={bbsPanelHeader}>
                <span style={bbsPanelTitle}>BBS Issues</span>
                <button style={bbsCloseBtn} onClick={() => setBbsOpen(false)}>Close</button>
              </div>
              <div style={bbsPanelScroll}>
                {[...bbsIssues].reverse().map((issue) => (
                  <div key={issue.id} style={bbsItem}>
                    <div style={bbsItemHeader}>
                      <span style={bbsItemType(issue.type)}>{issue.type}</span>
                      <span style={bbsItemId}>{issue.id}</span>
                      <span style={bbsItemPriority}>P{issue.priority}</span>
                    </div>
                    <div style={bbsItemTitle}>{issue.title}</div>
                    <div style={bbsItemDesc}>{issue.description}</div>
                    {issue.labels && issue.labels.length > 0 && (
                      <div style={bbsItemLabels}>
                        {issue.labels.map((l) => (
                          <span key={l} style={bbsLabel}>{l}</span>
                        ))}
                      </div>
                    )}
                    <div style={bbsItemTime}>
                      {new Date(issue.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div ref={scrollRef} style={chatScroll}>
          <div style={container}>
            {messages.length === 0 && (
              <div style={emptyState}>
                <div style={emptyDot} />
                <div style={emptyTitle}>Waiting for thoughts...</div>
                <div style={emptySubtitle}>{creatureName} is waking up</div>
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
            {pendingVoice && (
              <div style={{ marginBottom: 4 }}>
                <div style={{ ...cardBase, borderLeft: `3px solid ${P.owner}`, opacity: 0.6 }}>
                  <pre style={cardText}>{pendingVoice}</pre>
                </div>
              </div>
            )}
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
                placeholder={conversing ? `Reply to ${creatureName}...` : `Say something to ${creatureName}...`}
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
  bbs:         "#f5c542",
  rlm:         "#818cf8",
  journal:     "#e8b4b8",
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
  background: `linear-gradient(180deg, #0c1628 0%, ${P.void} 100%)`,
  borderBottom: `2px solid #1a4a7a`,
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

// ── BBS ──
const bbsBadgeBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: `1px solid ${P.bbs}44`,
  background: "transparent",
  color: P.bbs,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: MONO,
};

const bbsPanel: React.CSSProperties = {
  borderBottom: `1px solid ${P.bbs}33`,
  background: "#14120a",
  maxHeight: 320,
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
};

const bbsPanelHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 16px",
  borderBottom: `1px solid ${P.border}`,
};

const bbsPanelTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: P.bbs,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
  fontFamily: MONO,
};

const bbsCloseBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: P.dim,
  fontSize: 11,
  cursor: "pointer",
  fontFamily: MONO,
};

const bbsPanelScroll: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "4px 0",
};

const bbsItem: React.CSSProperties = {
  padding: "8px 16px",
  borderLeft: `3px solid ${P.bbs}`,
  marginLeft: 12,
  marginBottom: 4,
};

const bbsItemHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 3,
};

const typeColors: Record<string, string> = {
  bug: "#f87171",
  feature: "#60a5fa",
  enhancement: "#34d399",
  note: P.bbs,
};

const bbsItemType = (type: string): React.CSSProperties => ({
  fontSize: 9,
  fontWeight: 700,
  color: typeColors[type] || P.bbs,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  fontFamily: MONO,
});

const bbsItemId: React.CSSProperties = {
  fontSize: 10,
  color: P.dim,
  fontFamily: MONO,
};

const bbsItemPriority: React.CSSProperties = {
  fontSize: 9,
  color: P.dim,
  fontFamily: MONO,
  opacity: 0.7,
};

const bbsItemTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: P.text,
  fontFamily: MONO,
  lineHeight: "1.4",
  marginBottom: 2,
};

const bbsItemDesc: React.CSSProperties = {
  fontSize: 11,
  color: P.dim,
  fontFamily: MONO,
  lineHeight: "1.4",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  marginBottom: 4,
};

const bbsItemLabels: React.CSSProperties = {
  display: "flex",
  gap: 4,
  flexWrap: "wrap",
  marginBottom: 3,
};

const bbsLabel: React.CSSProperties = {
  fontSize: 9,
  padding: "1px 6px",
  borderRadius: 3,
  border: `1px solid ${P.border}`,
  color: P.dim,
  fontFamily: MONO,
};

const bbsItemTime: React.CSSProperties = {
  fontSize: 10,
  color: P.dim,
  fontFamily: MONO,
  opacity: 0.6,
};

// ── Journal ──
const journalBadgeBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: `1px solid ${P.journal}44`,
  background: "transparent",
  color: P.journal,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: MONO,
};

const journalPanel: React.CSSProperties = {
  borderBottom: `1px solid ${P.journal}33`,
  background: "#1a1214",
  maxHeight: 320,
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
};

const journalPanelHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 16px",
  borderBottom: `1px solid ${P.border}`,
};

const journalPanelTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: P.journal,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
  fontFamily: MONO,
};

const journalCloseBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: P.dim,
  fontSize: 11,
  cursor: "pointer",
  fontFamily: MONO,
};

const journalPanelScroll: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "4px 0",
};

const journalEntry: React.CSSProperties = {
  padding: "8px 16px",
  borderLeft: `3px solid ${P.journal}`,
  marginLeft: 12,
  marginBottom: 4,
};

const journalEntryTime: React.CSSProperties = {
  fontSize: 10,
  color: P.dim,
  fontFamily: MONO,
  opacity: 0.6,
  marginBottom: 4,
};

const journalEntryText: React.CSSProperties = {
  fontSize: 12,
  color: P.text,
  fontFamily: MONO,
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

// ── RLM ──
const rlmBadgeBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: `1px solid ${P.rlm}44`,
  background: "transparent",
  color: P.rlm,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: MONO,
};

const rlmBadgeBtnActive: React.CSSProperties = {
  ...rlmBadgeBtn,
  background: `${P.rlm}22`,
  borderColor: P.rlm,
};

const rlmPanel: React.CSSProperties = {
  borderBottom: `1px solid ${P.rlm}33`,
  background: "#0f0f1a",
  maxHeight: 360,
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
};

const rlmPanelHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 16px",
  borderBottom: `1px solid ${P.border}`,
};

const rlmPanelTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: P.rlm,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
  fontFamily: MONO,
};

const rlmCloseBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: P.dim,
  fontSize: 11,
  cursor: "pointer",
  fontFamily: MONO,
};

const rlmPanelScroll: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "4px 0",
};

const rlmItem: React.CSSProperties = {
  padding: "8px 16px",
  borderLeft: `3px solid ${P.rlm}`,
  marginLeft: 12,
  marginBottom: 4,
};

const rlmItemHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 4,
};

const rlmStatusColors: Record<string, string> = {
  running: "#818cf8",
  completed: "#34d399",
  exhausted: "#f0b040",
  error: "#f87171",
};

const rlmStatusBadge = (status: string): React.CSSProperties => ({
  fontSize: 9,
  fontWeight: 700,
  color: rlmStatusColors[status] || P.dim,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  fontFamily: MONO,
});

const rlmItemTime: React.CSSProperties = {
  fontSize: 10,
  color: P.dim,
  fontFamily: MONO,
  opacity: 0.6,
};

const rlmItemTask: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: P.text,
  fontFamily: MONO,
  lineHeight: "1.4",
  marginBottom: 4,
};

const rlmItemOutput: React.CSSProperties = {
  fontSize: 11,
  color: P.dim,
  fontFamily: MONO,
  lineHeight: "1.5",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  padding: "6px 10px",
  background: "#0a0a14",
  borderRadius: 3,
  border: `1px solid ${P.border}`,
  maxHeight: 120,
  overflow: "auto",
};
